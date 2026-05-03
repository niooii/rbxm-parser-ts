/**
 * @author https://github.com/niooii
 * Contains the core classes for reading and writing Roblox XML model files.
 */

import { XMLParser } from "fast-xml-parser";

import { ClassMap, EnumFactory, EnumMap } from "../generated/generated_types";
import { Axes, CFrame, Color3, ColorSequence, ColorSequenceKeypoint, CoreInstance, DataType, EnumItem, Faces, FontStyle, FontWeight, NumberRange,
    NumberSequence, NumberSequenceKeypoint, PhysicalProperties, Ray, RBXMAxis, RBXMFace, RBXMFont, Rect, RobloxValue, SharedString,
    SharedStringValue, UDim, UDim2, UniqueId, Vector2, Vector3 } from "./roblox_types";
import { RobloxFile } from "./roblox_file";

type XmlNode = Record<string, unknown>

type PendingRef = {
    instance: CoreInstance
    propName: string
    referent: string
}

type PendingSharedString = {
    instance: CoreInstance
    propName: string
    key: string
}

/**
 * This class can read .rbxmx/.rbxlx XML bytes to create a RobloxFile.
 */
export class RobloxFileXMLReader
{
    protected model: RobloxFile = new RobloxFile();
    protected classMap: ClassMap = new ClassMap();
    protected enumMap: EnumMap = new EnumMap();
    protected referentToInstance: Map<string, CoreInstance> = new Map<string, CoreInstance>();
    protected pendingRefs: PendingRef[] = [];
    protected sharedStringToIndex: Map<string, number> = new Map<string, number>();
    protected pendingSharedStrings: PendingSharedString[] = [];
    protected propTypeCache: Map<string, Map<string, DataType>> = new Map<string, Map<string, DataType>>();

    /**
     * This will parse XML and create a RobloxFile object.
     * If the XML is not valid, this will return null.
     * @param data .rbxmx/.rbxlx bytes or XML text
     * @returns a Roblox file object or null if the XML is invalid.
     */
    public read(data: Uint8Array | string)
    {
        this.model = new RobloxFile();
        this.referentToInstance.clear();
        this.pendingRefs = [];
        this.sharedStringToIndex.clear();
        this.pendingSharedStrings = [];

        const xml = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parser = new XMLParser({
            preserveOrder: true,
            ignoreAttributes: false,
            parseTagValue: false,
            parseAttributeValue: false,
            trimValues: false,
            cdataPropName: "#cdata",
            ignoreDeclaration: true,
            maxNestedTags: 10000
        });

        const parsed = parser.parse(xml) as XmlNode[];
        const robloxNode = this.findNode(parsed, "roblox");
        if (!robloxNode)
        {
            return null;
        }

        if (this.getAttr(robloxNode, "version") !== "4")
        {
            return null;
        }

        for (const child of this.getChildren(robloxNode))
        {
            const name = this.getNodeName(child);
            switch (name)
            {
                case "Meta":
                    this.readMeta(child);
                    break;
                case "Item":
                    this.readInstance(child);
                    break;
                case "SharedStrings":
                    this.readSharedStrings(child);
                    break;
            }
        }

        this.applyPendingRefs();
        this.applyPendingSharedStrings();

        if (this.model.Roots.length === 0) return null;
        return this.model;
    }

    protected readMeta(node: XmlNode)
    {
        const name = this.getAttr(node, "name");
        if (!name) return;

        this.model.Metadata.set(name, this.getText(this.getChildren(node)));
    }

    protected readSharedStrings(node: XmlNode)
    {
        for (const child of this.getChildren(node))
        {
            if (this.getNodeName(child) !== "SharedString") continue;

            const key = this.getAttr(child, "md5");
            if (!key || this.sharedStringToIndex.has(key)) continue;

            const value = this.decodeBase64String(this.getText(this.getChildren(child)));
            const hash = this.decodeBase64Bytes(key);
            this.sharedStringToIndex.set(key, this.model.SharedStrings.length);
            this.model.SharedStrings.push(new SharedString(value, hash));
        }
    }

    protected readInstance(node: XmlNode, parent?: CoreInstance)
    {
        const className = this.getAttr(node, "class");
        if (!className) return undefined;

        const classFactory = this.classMap.getFactory(className);
        const instance = classFactory ? classFactory() : new CoreInstance(false, className);
        instance.ResetProps();

        const referent = this.getAttr(node, "referent");
        if (referent)
        {
            this.referentToInstance.set(referent, instance);
            this.model.ReferentMap.set(instance, this.model.ReferentMap.size);
        }

        if (parent)
        {
            instance.Parent = parent;
        }
        else
        {
            this.model.AddRoot(instance);
        }

        for (const child of this.getChildren(node))
        {
            const name = this.getNodeName(child);
            if (name === "Properties")
            {
                this.readProperties(child, instance, className);
            }
            else if (name === "Item")
            {
                this.readInstance(child, instance);
            }
        }

        return instance;
    }

    protected readProperties(node: XmlNode, instance: CoreInstance, className: string)
    {
        for (const child of this.getChildren(node))
        {
            const tag = this.getNodeName(child);
            if (!tag) continue;

            const propName = this.getAttr(child, "name");
            if (!propName) continue;

            const children = this.getChildren(child);
            if (tag === "Ref")
            {
                this.readRefProperty(instance, propName, children);
                continue;
            }
            else if (tag === "SharedString" || tag === "NetAssetRef")
            {
                this.readSharedStringProperty(instance, propName, children);
                continue;
            }

            const value = this.readValue(tag, propName, className, children);
            if (value)
            {
                instance.SetProp(propName, value.type, value.value);
            }
        }
    }

    protected readRefProperty(instance: CoreInstance, propName: string, nodes: XmlNode[])
    {
        const referent = this.getText(nodes).trim();
        if (!referent || referent === "null") return;

        const refInstance = this.referentToInstance.get(referent);
        if (refInstance)
        {
            instance.SetProp(propName, DataType.Referent, refInstance);
        }
        else
        {
            this.pendingRefs.push({ instance: instance, propName: propName, referent: referent });
        }
    }

    protected readSharedStringProperty(instance: CoreInstance, propName: string, nodes: XmlNode[])
    {
        const key = this.getText(nodes).trim();
        if (!key) return;

        const index = this.sharedStringToIndex.get(key);
        if (index !== undefined)
        {
            instance.SetProp(propName, DataType.SharedString, new SharedStringValue(index));
        }
        else
        {
            this.pendingSharedStrings.push({ instance: instance, propName: propName, key: key });
        }
    }

    protected readValue(tag: string, propName: string, className: string, nodes: XmlNode[]): RobloxValue | undefined
    {
        switch (tag)
        {
            case "string":
            case "ProtectedString":
                return { type: DataType.String, value: this.getText(nodes) };
            case "BinaryString":
                return { type: DataType.String, value: this.decodeBase64String(this.getText(nodes)) };
            case "Content":
            case "ContentId":
                return { type: DataType.String, value: this.readContent(nodes) };
            case "bool":
                return { type: DataType.Bool, value: this.readBool(this.getText(nodes)) };
            case "int":
            {
                const intValue = this.readInt(this.getText(nodes));
                if (this.getKnownPropType(className, propName) === DataType.BrickColor)
                {
                    return { type: DataType.BrickColor, value: intValue };
                }
                return { type: DataType.Int32, value: intValue };
            }
            case "BrickColor":
                return { type: DataType.BrickColor, value: this.readInt(this.getText(nodes)) };
            case "float":
                return { type: DataType.Float32, value: this.readFloat(this.getText(nodes)) };
            case "double":
                return { type: DataType.Float64, value: this.readFloat(this.getText(nodes)) };
            case "int64":
                return { type: DataType.Int64, value: this.readBigInt(this.getText(nodes)) };
            case "UDim":
                return { type: DataType.UDim, value: this.readUDim(nodes) };
            case "UDim2":
                return { type: DataType.UDim2, value: this.readUDim2(nodes) };
            case "Ray":
                return { type: DataType.Ray, value: this.readRay(nodes) };
            case "Faces":
                return { type: DataType.Faces, value: this.readFaces(nodes) };
            case "Axes":
                return { type: DataType.Axes, value: this.readAxes(nodes) };
            case "Color3":
                return { type: DataType.Color3, value: this.readColor3(nodes) };
            case "Color3uint8":
                return { type: DataType.Color3uint8, value: this.readColor3uint8(nodes) };
            case "Vector2":
                return { type: DataType.Vector2, value: this.readVector2(nodes) };
            case "Vector3":
                return { type: DataType.Vector3, value: this.readVector3(nodes) };
            case "Vector3int16":
                return { type: DataType.Vector3int16, value: this.readVector3(nodes) };
            case "CoordinateFrame":
            case "CFrame":
                return { type: DataType.CFrame, value: this.readCFrame(nodes) };
            case "OptionalCoordinateFrame":
            {
                const cframeNode = this.findNode(nodes, "CFrame");
                if (!cframeNode) return undefined;
                return { type: DataType.OptionalCFrame, value: this.readCFrame(this.getChildren(cframeNode)) };
            }
            case "token":
                return { type: DataType.Enum, value: this.createEnumValue(this.readInt(this.getText(nodes)), this.getEnumFactory(className, propName)) };
            case "NumberSequence":
                return { type: DataType.NumberSequence, value: this.readNumberSequence(nodes) };
            case "ColorSequence":
                return { type: DataType.ColorSequence, value: this.readColorSequence(nodes) };
            case "NumberRange":
                return { type: DataType.NumberRange, value: this.readNumberRange(nodes) };
            case "Rect2D":
            case "Rect":
                return { type: DataType.Rect, value: this.readRect(nodes) };
            case "PhysicalProperties":
                return { type: DataType.PhysicalProperties, value: this.readPhysicalProperties(nodes) };
            case "UniqueId":
                return { type: DataType.UniqueId, value: this.readUniqueId(nodes) };
            case "Font":
                return { type: DataType.Font, value: this.readFont(nodes) };
            case "SecurityCapabilities":
                return { type: DataType.SecurityCapabilities, value: this.readBigInt(this.getText(nodes)) };
        }

        return undefined;
    }

    protected readContent(nodes: XmlNode[])
    {
        const contentNode = nodes.find((node) => !!this.getNodeName(node));
        if (!contentNode) return "";

        const tag = this.getNodeName(contentNode);
        if (tag === "null") return "";
        if (tag === "url" || tag === "uri" || tag === "Ref") return this.getText(this.getChildren(contentNode));
        return "";
    }

    protected readUDim(nodes: XmlNode[])
    {
        return new UDim(this.readFloat(this.getChildText(nodes, "S")), this.readInt(this.getChildText(nodes, "O")));
    }

    protected readUDim2(nodes: XmlNode[])
    {
        const x = new UDim(this.readFloat(this.getChildText(nodes, "XS")), this.readInt(this.getChildText(nodes, "XO")));
        const y = new UDim(this.readFloat(this.getChildText(nodes, "YS")), this.readInt(this.getChildText(nodes, "YO")));
        return new UDim2(x, y);
    }

    protected readRay(nodes: XmlNode[])
    {
        return new Ray(this.readVector3(this.getChildNodes(nodes, "origin")), this.readVector3(this.getChildNodes(nodes, "direction")));
    }

    protected readAxes(nodes: XmlNode[])
    {
        const bits = this.readInt(this.getChildText(nodes, "axes"));
        const axes: RBXMAxis[] = [];
        for (const axis of [RBXMAxis.X, RBXMAxis.Y, RBXMAxis.Z])
        {
            if ((bits & axis) !== 0) axes.push(axis);
        }
        return new Axes(...axes);
    }

    protected readFaces(nodes: XmlNode[])
    {
        const bits = this.readInt(this.getChildText(nodes, "faces"));
        const faces: RBXMFace[] = [];
        if ((bits & 0b000001) !== 0) faces.push(RBXMFace.Right);
        if ((bits & 0b000010) !== 0) faces.push(RBXMFace.Top);
        if ((bits & 0b000100) !== 0) faces.push(RBXMFace.Back);
        if ((bits & 0b001000) !== 0) faces.push(RBXMFace.Left);
        if ((bits & 0b010000) !== 0) faces.push(RBXMFace.Bottom);
        if ((bits & 0b100000) !== 0) faces.push(RBXMFace.Front);
        return new Faces(...faces);
    }

    protected readColor3(nodes: XmlNode[])
    {
        const text = this.getText(nodes).trim();
        if (text)
        {
            return this.readPackedColor3(Number.parseInt(text, 10));
        }

        return new Color3(
            this.readFloat(this.getChildText(nodes, "R")),
            this.readFloat(this.getChildText(nodes, "G")),
            this.readFloat(this.getChildText(nodes, "B"))
        );
    }

    protected readColor3uint8(nodes: XmlNode[])
    {
        return this.readPackedColor3(Number.parseInt(this.getText(nodes).trim(), 10));
    }

    protected readPackedColor3(packed: number)
    {
        const r = Math.floor(packed / 0x10000) % 0x100;
        const g = Math.floor(packed / 0x100) % 0x100;
        const b = packed % 0x100;
        return Color3.FromRGB(r, g, b);
    }

    protected readVector2(nodes: XmlNode[])
    {
        return new Vector2(this.readFloat(this.getChildText(nodes, "X")), this.readFloat(this.getChildText(nodes, "Y")));
    }

    protected readVector3(nodes: XmlNode[])
    {
        return new Vector3(this.readFloat(this.getChildText(nodes, "X")), this.readFloat(this.getChildText(nodes, "Y")), this.readFloat(this.getChildText(nodes, "Z")));
    }

    protected readCFrame(nodes: XmlNode[])
    {
        const position = new Vector3(this.readFloat(this.getChildText(nodes, "X")), this.readFloat(this.getChildText(nodes, "Y")), this.readFloat(this.getChildText(nodes, "Z")));
        const orientation = ["R00", "R01", "R02", "R10", "R11", "R12", "R20", "R21", "R22"].map((tag) => this.readFloat(this.getChildText(nodes, tag)));
        return new CFrame(position, orientation);
    }

    protected readNumberSequence(nodes: XmlNode[])
    {
        const values = this.readFloatList(nodes);
        const keypoints: NumberSequenceKeypoint[] = [];
        for (let i = 0; i + 2 < values.length; i += 3)
        {
            keypoints.push(new NumberSequenceKeypoint(values[i], values[i + 1], values[i + 2]));
        }
        return new NumberSequence(...keypoints);
    }

    protected readColorSequence(nodes: XmlNode[])
    {
        const values = this.readFloatList(nodes);
        const keypoints: ColorSequenceKeypoint[] = [];
        for (let i = 0; i + 4 < values.length; i += 5)
        {
            keypoints.push(new ColorSequenceKeypoint(values[i], new Color3(values[i + 1], values[i + 2], values[i + 3])));
        }
        return new ColorSequence(...keypoints);
    }

    protected readNumberRange(nodes: XmlNode[])
    {
        const values = this.readFloatList(nodes);
        return new NumberRange(values[0] ?? 0, values[1] ?? 0);
    }

    protected readRect(nodes: XmlNode[])
    {
        return new Rect(this.readVector2(this.getChildNodes(nodes, "min")), this.readVector2(this.getChildNodes(nodes, "max")));
    }

    protected readPhysicalProperties(nodes: XmlNode[])
    {
        const isCustom = this.readBool(this.getChildText(nodes, "CustomPhysics"));
        const hasAcousticAbsorption = this.findNode(nodes, "AcousticAbsorption") !== undefined;
        if (!isCustom)
        {
            return PhysicalProperties.Default(hasAcousticAbsorption);
        }

        return new PhysicalProperties(
            this.readFloat(this.getChildText(nodes, "Density")),
            this.readFloat(this.getChildText(nodes, "Friction")),
            this.readFloat(this.getChildText(nodes, "Elasticity")),
            this.readFloat(this.getChildText(nodes, "FrictionWeight")),
            this.readFloat(this.getChildText(nodes, "ElasticityWeight")),
            hasAcousticAbsorption ? this.readFloat(this.getChildText(nodes, "AcousticAbsorption")) : undefined
        );
    }

    protected readUniqueId(nodes: XmlNode[])
    {
        const value = this.getText(nodes).trim();
        if (value.length !== 32)
        {
            return new UniqueId(0, 0, BigInt(0));
        }

        const random = BigInt.asIntN(64, BigInt(`0x${value.slice(0, 16)}`));
        const time = Number.parseInt(value.slice(16, 24), 16);
        const index = Number.parseInt(value.slice(24, 32), 16);
        return new UniqueId(index, time, random);
    }

    protected readFont(nodes: XmlNode[])
    {
        const family = this.readContent(this.getChildNodes(nodes, "Family"));
        const weight = this.readInt(this.getChildText(nodes, "Weight")) as FontWeight;
        const style = this.getChildText(nodes, "Style") === "Italic" ? FontStyle.Italic : FontStyle.Normal;
        const cachedFaceIdNode = this.findNode(nodes, "CachedFaceId");
        const cachedFaceId = cachedFaceIdNode ? this.readContent(this.getChildren(cachedFaceIdNode)) : undefined;
        return new RBXMFont(family, weight, style, cachedFaceId);
    }

    protected readFloatList(nodes: XmlNode[])
    {
        return this.getText(nodes).split(/\s+/).filter((value) => value.length > 0).map((value) => this.readFloat(value));
    }

    protected readBool(value: string)
    {
        return value.trim().toLowerCase() === "true";
    }

    protected readInt(value: string)
    {
        const parsed = Number.parseInt(value.trim(), 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    protected readBigInt(value: string)
    {
        try
        {
            return BigInt(value.trim() || "0");
        }
        catch
        {
            return BigInt(0);
        }
    }

    protected readFloat(value: string)
    {
        switch (value.trim())
        {
            case "INF":
            case "+INF":
                return Infinity;
            case "-INF":
                return -Infinity;
            case "NAN":
                return NaN;
        }

        const parsed = Number.parseFloat(value.trim());
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    protected applyPendingRefs()
    {
        for (const rewrite of this.pendingRefs)
        {
            const instance = this.referentToInstance.get(rewrite.referent);
            if (instance)
            {
                rewrite.instance.SetProp(rewrite.propName, DataType.Referent, instance);
            }
        }
    }

    protected applyPendingSharedStrings()
    {
        for (const rewrite of this.pendingSharedStrings)
        {
            let index = this.sharedStringToIndex.get(rewrite.key);
            if (index === undefined)
            {
                index = this.model.SharedStrings.length;
                this.sharedStringToIndex.set(rewrite.key, index);
                this.model.SharedStrings.push(new SharedString("", this.decodeBase64Bytes(rewrite.key)));
            }
            rewrite.instance.SetProp(rewrite.propName, DataType.SharedString, new SharedStringValue(index));
        }
    }

    protected getEnumFactory(className: string, propName: string)
    {
        const classFactory = this.classMap.getFactory(className);
        if (classFactory)
        {
            const fakeInstance = classFactory();
            for (const inheritedClassName of fakeInstance.ClassNameList)
            {
                const enumFactory = this.enumMap.getFactory(inheritedClassName, propName);
                if (enumFactory)
                {
                    return enumFactory;
                }
            }
        }
        return this.enumMap.getFactory(className, propName);
    }

    protected createEnumValue(value: number, enumFactory?: EnumFactory)
    {
        if (enumFactory)
        {
            const enumValue = enumFactory(value);
            return enumValue ?? EnumItem.MakeUnknownEnum(value);
        }
        return EnumItem.MakeUnknownEnum(value);
    }

    protected getKnownPropType(className: string, propName: string)
    {
        let props = this.propTypeCache.get(className);
        if (!props)
        {
            props = new Map<string, DataType>();
            const classFactory = this.classMap.getFactory(className);
            if (classFactory)
            {
                const instance = classFactory();
                for (const [name, value] of instance.Props)
                {
                    props.set(name, value.type);
                }
            }
            this.propTypeCache.set(className, props);
        }
        return props.get(propName);
    }

    protected findNode(nodes: XmlNode[], name: string)
    {
        return nodes.find((node) => this.getNodeName(node) === name);
    }

    protected getNodeName(node: XmlNode)
    {
        for (const key of Object.keys(node))
        {
            if (key !== ":@" && key !== "#text" && key !== "#cdata")
            {
                return key;
            }
        }
        return "";
    }

    protected getChildren(node: XmlNode)
    {
        const name = this.getNodeName(node);
        const children = node[name];
        return Array.isArray(children) ? children as XmlNode[] : [];
    }

    protected getChildNodes(nodes: XmlNode[], name: string)
    {
        const node = this.findNode(nodes, name);
        return node ? this.getChildren(node) : [];
    }

    protected getChildText(nodes: XmlNode[], name: string)
    {
        return this.getText(this.getChildNodes(nodes, name));
    }

    protected getText(nodes: XmlNode[])
    {
        let text = "";
        for (const node of nodes)
        {
            if (typeof node["#text"] === "string")
            {
                text += node["#text"];
            }
            else if (typeof node["#cdata"] === "string")
            {
                text += node["#cdata"];
            }
            else if (Array.isArray(node["#cdata"]))
            {
                text += this.getText(node["#cdata"] as XmlNode[]);
            }
        }
        return text;
    }

    protected getAttr(node: XmlNode, name: string)
    {
        const attrs = node[":@"];
        if (!attrs || typeof attrs !== "object") return undefined;

        return (attrs as Record<string, unknown>)[`@_${name}`] as string | undefined;
    }

    protected decodeBase64String(value: string)
    {
        const clean = value.replace(/\s/g, "");
        return clean ? Buffer.from(clean, "base64").toString("latin1") : "";
    }

    protected decodeBase64Bytes(value: string)
    {
        const clean = value.replace(/\s/g, "");
        return new Uint8Array(clean ? Buffer.from(clean, "base64") : []);
    }
}

/**
 * This class can write .rbxmx/.rbxlx XML text from a given RobloxFile.
 */
export class RobloxFileXMLWriter
{
    protected model: RobloxFile;
    protected instToRefId: Map<CoreInstance, number> = new Map<CoreInstance, number>();

    public constructor(model: RobloxFile)
    {
        this.model = model;
    }

    public write()
    {
        this.setup();

        const output: string[] = [];
        output.push("<roblox version=\"4\">");
        for (const [key, value] of this.model.Metadata)
        {
            output.push("<Meta name=\"", this.escapeXml(key), "\">", this.escapeXml(value), "</Meta>");
        }
        for (const root of this.model.Roots)
        {
            this.writeInstance(output, root);
        }
        this.writeSharedStrings(output);
        output.push("</roblox>");
        return output.join("");
    }

    protected setup()
    {
        let referent = 0;
        for (const instance of this.model.GetAllDescendants())
        {
            if (!instance.IsDestroyed)
            {
                this.instToRefId.set(instance, referent);
                ++referent;
            }
        }
    }

    protected writeInstance(output: string[], instance: CoreInstance)
    {
        output.push("<Item class=\"", this.escapeXml(instance.ClassName), "\" referent=\"RBX", String(this.instToRefId.get(instance) ?? 0), "\"><Properties>");

        const props = Array.from(instance.Props.entries());
        props.sort((prop1, prop2) => prop1[0] > prop2[0] ? 1 : -1);
        for (const [name, value] of props)
        {
            this.writeProperty(output, name, value);
        }

        output.push("</Properties>");
        for (const child of instance.Children)
        {
            this.writeInstance(output, child);
        }
        output.push("</Item>");
    }

    protected writeProperty(output: string[], name: string, value: RobloxValue)
    {
        const written = this.writeValue(value);
        if (!written) return;

        output.push("<", written.tag, " name=\"", this.escapeXml(name), "\">", written.value, "</", written.tag, ">");
    }

    protected writeValue(value: RobloxValue): { tag: string, value: string } | undefined
    {
        switch (value.type)
        {
            case DataType.String:
                return { tag: "string", value: this.escapeXml(value.value) };
            case DataType.Bool:
                return { tag: "bool", value: value.value ? "true" : "false" };
            case DataType.Int32:
                return { tag: "int", value: String(value.value) };
            case DataType.Float32:
                return { tag: "float", value: this.writeFloat(value.value) };
            case DataType.Float64:
                return { tag: "double", value: this.writeFloat(value.value) };
            case DataType.UDim:
                return { tag: "UDim", value: this.writeUDim(value.value) };
            case DataType.UDim2:
                return { tag: "UDim2", value: this.writeUDim2(value.value) };
            case DataType.Ray:
                return { tag: "Ray", value: "<origin>" + this.writeVector3(value.value.Origin) + "</origin><direction>" + this.writeVector3(value.value.Direction) + "</direction>" };
            case DataType.Faces:
                return { tag: "Faces", value: "<faces>" + this.writeFaces(value.value) + "</faces>" };
            case DataType.Axes:
                return { tag: "Axes", value: "<axes>" + this.writeAxes(value.value) + "</axes>" };
            case DataType.BrickColor:
                return { tag: "int", value: String(value.value) };
            case DataType.Color3:
                return { tag: "Color3", value: "<R>" + this.writeFloat(value.value.R) + "</R><G>" + this.writeFloat(value.value.G) + "</G><B>" + this.writeFloat(value.value.B) + "</B>" };
            case DataType.Vector2:
                return { tag: "Vector2", value: this.writeVector2(value.value) };
            case DataType.Vector3:
                return { tag: "Vector3", value: this.writeVector3(value.value) };
            case DataType.CFrame:
                return { tag: "CoordinateFrame", value: this.writeCFrame(value.value) };
            case DataType.Enum:
                return { tag: "token", value: String(value.value.Value) };
            case DataType.Referent:
            {
                const referent = this.instToRefId.get(value.value);
                return { tag: "Ref", value: referent === undefined ? "null" : "RBX" + String(referent) };
            }
            case DataType.Color3uint8:
                return { tag: "Color3uint8", value: String(this.writePackedColor3(value.value)) };
            case DataType.Vector3int16:
                return { tag: "Vector3int16", value: this.writeVector3(value.value) };
            case DataType.NumberSequence:
                return { tag: "NumberSequence", value: value.value.Keypoints.map((keypoint) => `${this.writeFloat(keypoint.Time)} ${this.writeFloat(keypoint.Value)} ${this.writeFloat(keypoint.Envelope)} `).join("") };
            case DataType.ColorSequence:
                return { tag: "ColorSequence", value: value.value.Keypoints.map((keypoint) => `${this.writeFloat(keypoint.Time)} ${this.writeFloat(keypoint.Color.R)} ${this.writeFloat(keypoint.Color.G)} ${this.writeFloat(keypoint.Color.B)} 0 `).join("") };
            case DataType.NumberRange:
                return { tag: "NumberRange", value: `${this.writeFloat(value.value.Min)} ${this.writeFloat(value.value.Max)} ` };
            case DataType.Rect:
                return { tag: "Rect2D", value: "<min>" + this.writeVector2(value.value.Min) + "</min><max>" + this.writeVector2(value.value.Max) + "</max>" };
            case DataType.PhysicalProperties:
                return { tag: "PhysicalProperties", value: this.writePhysicalProperties(value.value) };
            case DataType.Int64:
                return { tag: "int64", value: value.value.toString() };
            case DataType.SharedString:
                return { tag: "SharedString", value: this.writeSharedStringRef(value.value) };
            case DataType.Bytecode:
                return { tag: "ProtectedString", value: this.writeProtectedString(value.value) };
            case DataType.OptionalCFrame:
                return { tag: "OptionalCoordinateFrame", value: "<CFrame>" + this.writeCFrame(value.value) + "</CFrame>" };
            case DataType.UniqueId:
                return { tag: "UniqueId", value: value.value.toString() };
            case DataType.Font:
                return { tag: "Font", value: this.writeFont(value.value) };
            case DataType.SecurityCapabilities:
                return { tag: "SecurityCapabilities", value: value.value.toString() };
        }
    }

    protected writeUDim(value: UDim)
    {
        return "<S>" + this.writeFloat(value.Scale) + "</S><O>" + String(value.Offset) + "</O>";
    }

    protected writeUDim2(value: UDim2)
    {
        return "<XS>" + this.writeFloat(value.X.Scale) + "</XS><XO>" + String(value.X.Offset) + "</XO><YS>" + this.writeFloat(value.Y.Scale) + "</YS><YO>" + String(value.Y.Offset) + "</YO>";
    }

    protected writeVector2(value: Vector2)
    {
        return "<X>" + this.writeFloat(value.X) + "</X><Y>" + this.writeFloat(value.Y) + "</Y>";
    }

    protected writeVector3(value: Vector3)
    {
        return "<X>" + this.writeFloat(value.X) + "</X><Y>" + this.writeFloat(value.Y) + "</Y><Z>" + this.writeFloat(value.Z) + "</Z>";
    }

    protected writeCFrame(value: CFrame)
    {
        const pos = value.Position;
        const rot = value.Orientation;
        return "<X>" + this.writeFloat(pos.X) + "</X><Y>" + this.writeFloat(pos.Y) + "</Y><Z>" + this.writeFloat(pos.Z) + "</Z>"
            + "<R00>" + this.writeFloat(rot[0]) + "</R00><R01>" + this.writeFloat(rot[1]) + "</R01><R02>" + this.writeFloat(rot[2]) + "</R02>"
            + "<R10>" + this.writeFloat(rot[3]) + "</R10><R11>" + this.writeFloat(rot[4]) + "</R11><R12>" + this.writeFloat(rot[5]) + "</R12>"
            + "<R20>" + this.writeFloat(rot[6]) + "</R20><R21>" + this.writeFloat(rot[7]) + "</R21><R22>" + this.writeFloat(rot[8]) + "</R22>";
    }

    protected writeAxes(value: Axes)
    {
        let bits = 0;
        for (const axis of value.Axes)
        {
            bits |= axis;
        }
        return bits;
    }

    protected writeFaces(value: Faces)
    {
        let bits = 0;
        for (const face of value.Faces)
        {
            switch (face)
            {
                case RBXMFace.Right:
                    bits |= 0b000001;
                    break;
                case RBXMFace.Top:
                    bits |= 0b000010;
                    break;
                case RBXMFace.Back:
                    bits |= 0b000100;
                    break;
                case RBXMFace.Left:
                    bits |= 0b001000;
                    break;
                case RBXMFace.Bottom:
                    bits |= 0b010000;
                    break;
                case RBXMFace.Front:
                    bits |= 0b100000;
                    break;
            }
        }
        return bits;
    }

    protected writePackedColor3(value: Color3)
    {
        return 0xff000000 + (Color3.FloatToUint8(value.R) << 16) + (Color3.FloatToUint8(value.G) << 8) + Color3.FloatToUint8(value.B);
    }

    protected writePhysicalProperties(value: PhysicalProperties)
    {
        let output = "<CustomPhysics>" + (value.IsCustom ? "true" : "false") + "</CustomPhysics>";
        if (value.IsCustom)
        {
            output += "<Density>" + this.writeFloat(value.Density) + "</Density><Friction>" + this.writeFloat(value.Friction) + "</Friction><Elasticity>" + this.writeFloat(value.Elasticity) + "</Elasticity>"
                + "<FrictionWeight>" + this.writeFloat(value.FrictionWeight) + "</FrictionWeight><ElasticityWeight>" + this.writeFloat(value.ElasticityWeight) + "</ElasticityWeight>";
            if (value.HasAcousticAbsorption)
            {
                output += "<AcousticAbsorption>" + this.writeFloat(value.AcousticAbsorption) + "</AcousticAbsorption>";
            }
        }
        return output;
    }

    protected writeSharedStringRef(value: SharedStringValue)
    {
        const sharedString = this.model.SharedStrings[value.Index];
        return sharedString ? this.encodeBase64Bytes(sharedString.Hash) : "";
    }

    protected writeFont(value: RBXMFont)
    {
        let output = "<Family><url>" + this.escapeXml(value.Family) + "</url></Family><Weight>" + String(value.Weight) + "</Weight><Style>" + FontStyle[value.Style] + "</Style>";
        if (value.CachedFaceId)
        {
            output += "<CachedFaceId><url>" + this.escapeXml(value.CachedFaceId) + "</url></CachedFaceId>";
        }
        return output;
    }

    protected writeSharedStrings(output: string[])
    {
        if (this.model.SharedStrings.length < 1) return;

        output.push("<SharedStrings>");
        for (const sharedString of this.model.SharedStrings)
        {
            output.push("<SharedString md5=\"", this.encodeBase64Bytes(sharedString.Hash), "\">", this.encodeBase64String(sharedString.Value), "</SharedString>");
        }
        output.push("</SharedStrings>");
    }

    protected writeProtectedString(value: string)
    {
        if (value.includes("]]>") || value.includes("\0"))
        {
            return this.escapeXml(value);
        }
        return "<![CDATA[" + value + "]]>";
    }

    protected writeFloat(value: number)
    {
        if (value === Infinity) return "INF";
        if (value === -Infinity) return "-INF";
        if (Number.isNaN(value)) return "NAN";
        return String(value);
    }

    protected escapeXml(value: string)
    {
        let output = "";
        for (let i = 0; i < value.length; ++i)
        {
            const char = value[i];
            switch (char)
            {
                case "&":
                    output += "&amp;";
                    break;
                case "<":
                    output += "&lt;";
                    break;
                case ">":
                    output += "&gt;";
                    break;
                case "\"":
                    output += "&#34;";
                    break;
                case "'":
                    output += "&#39;";
                    break;
                case "\0":
                    break;
                default:
                {
                    const code = char.charCodeAt(0);
                    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code >= 127)
                    {
                        output += "&#" + code + ";";
                    }
                    else
                    {
                        output += char;
                    }
                }
            }
        }
        return output;
    }

    protected encodeBase64String(value: string)
    {
        return Buffer.from(value, "latin1").toString("base64");
    }

    protected encodeBase64Bytes(value: Uint8Array)
    {
        return Buffer.from(value).toString("base64");
    }
}
