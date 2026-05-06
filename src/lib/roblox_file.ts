/**
 * @author https://github.com/fiveman1
 * Contains the core classes to load and interact with a Roblox model/place file.
 */

import { ChildContainer, CoreInstance, DataType, SharedString, SharedStringValue } from "./roblox_types";
import { RobloxFileDOMReader } from "./roblox_file_reader";
import { RobloxFileDOMWriter } from "./roblox_file_writer";
import { RobloxFileXMLReader, RobloxFileXMLWriter } from "./roblox_file_xml";

// Helpful resources I used:
// https://dom.rojo.space/binary - Documentation for .rbxm format
// https://github.com/MaximumADHD/Roblox-File-Format - C# .rbxm parser

/**
 * Represents a Roblox model/place file. Contains all the data necessary for
 * saving/loading to a file.
 */
export class RobloxFile extends ChildContainer
{
    /**
     * Contains the mapping of metadata strings stored in the file. These come from the META chunk in the DOM.
     */
    public readonly Metadata: Map<string, string> = new Map<string, string>();
    
    /**
     * Contains the list of shared strings in the file. These come from the SSTR chunk in the DOM.
     */
    public readonly SharedStrings: SharedString[] = [];
    
    /**
     * This is used when loading and then saving a file to keep the reference to instance mapping consistent.
     * You probably shouldn't mess with this.
     */
    public readonly ReferentMap: Map<CoreInstance, number> = new Map<CoreInstance, number>();

    /**
     * The root instances of this file. This is a readonly array, to add or remove an instance
     * use AddToRoots and RemoveFromRoots
     */
    public get Roots(): readonly CoreInstance[]
    {
        return Array.from(this._children.values());
    }

    /**
     * Adds the given instance as a root of this file.
     * @param instance the instance
     */
    public AddRoot(instance: CoreInstance)
    {
        instance.RemoveParent();
        this._children.add(instance);
    }

    /**
     * Removes the given instance as a root of this file.
     * @param instance the instance
     */
    public RemoveFromRoots(instance: CoreInstance)
    {
        this._children.delete(instance);
        instance.Destroy();
    }

    /**
     * Copies SharedString entries referenced by the given instances from a source file
     * into this file, remapping property indices to match the new SharedStrings array.
     * Call this before AddRoot when transferring instances between files.
     * @param source the file the instances were read from
     * @param instances the instance trees to remap
     */
    public TransferSharedStrings(source: RobloxFile, instances: CoreInstance[])
    {
        const indexMap = new Map<number, number>();

        const walk = (inst: CoreInstance) =>
        {
            for (const [, prop] of inst.Props)
            {
                if (prop && prop.type === DataType.SharedString)
                {
                    const ssv = prop.value as SharedStringValue;
                    const oldIndex = ssv.Index;
                    if (!indexMap.has(oldIndex))
                    {
                        const entry = source.SharedStrings[oldIndex];
                        const newIndex = this.SharedStrings.length;
                        this.SharedStrings.push(
                            entry ? new SharedString(entry.Value, entry.Hash) : new SharedString("")
                        );
                        indexMap.set(oldIndex, newIndex);
                    }
                    ssv.Index = indexMap.get(oldIndex)!;
                }
            }
            for (const child of inst.Children)
            {
                walk(child);
            }
        };

        for (const inst of instances)
        {
            walk(inst);
        }
    }

    /**
     * Returns a deep copy of this model.
     * @returns a copy of this model
     */
    public Copy()
    {
        const copy = new RobloxFile();
        const instanceMap = new Map<CoreInstance, CoreInstance>();

        const mapInstances = (source: CoreInstance, target: CoreInstance) =>
        {
            instanceMap.set(source, target);

            for (let i = 0; i < source.Children.length; ++i)
            {
                const child = source.Children[i];
                const childCopy = target.Children[i];
                if (!child || !childCopy)
                {
                    throw new Error("Copied instance tree does not match source tree");
                }
                mapInstances(child, childCopy);
            }
        };

        for (const [key, value] of this.Metadata)
        {
            copy.Metadata.set(key, value);
        }

        for (const sharedString of this.SharedStrings)
        {
            copy.SharedStrings.push(new SharedString(sharedString.Value, sharedString.Hash));
        }

        for (const root of this.Roots)
        {
            const rootCopy = root.Copy();
            copy.AddRoot(rootCopy);
            mapInstances(root, rootCopy);
        }

        for (const [instance, referent] of this.ReferentMap)
        {
            const instanceCopy = instanceMap.get(instance);
            if (instanceCopy)
            {
                copy.ReferentMap.set(instanceCopy, referent);
            }
        }

        for (const [instance, instanceCopy] of instanceMap)
        {
            for (const [name, prop] of instance.Props)
            {
                if (prop.type === DataType.Referent)
                {
                    instanceCopy.SetProp(name, DataType.Referent, instanceMap.get(prop.value) ?? prop.value, false);
                }
            }
        }

        return copy;
    }

    /**
     * Writes this model to a Uint8Array and returns it.
     * @returns a Uint8Array that contains the file data in binary form
     * @example const buffer = file.WriteToBuffer();
     * fs.writeFileSync("my_roblox_file.rbxm", buffer);
     */
    public WriteToBuffer()
    {
        return new RobloxFileDOMWriter(this).write();
    }

    /**
     * Writes this model to XML text and returns it.
     * @returns a string that contains the file data in XML form
     */
    public WriteToXmlString()
    {
        return new RobloxFileXMLWriter(this).write();
    }

    /**
     * Writes this model to XML bytes and returns it.
     * @returns a Uint8Array that contains the file data in XML form
     */
    public WriteToXmlBuffer()
    {
        return new TextEncoder().encode(this.WriteToXmlString());
    }

    /**
     * Create a RobloxFile from a buffer. You could use fs.readFile
     * to load a .rbxm file then pass the result to this function to load it.
     * @param buffer a data buffer
     * @returns a Roblox file object
     * @example const file = RobloxFile.ReadFromBuffer(fs.readFileSync("my_file.rbxm"));
     */
    public static ReadFromBuffer(buffer: Uint8Array)
    {
        return new RobloxFileDOMReader().read(buffer);
    }

    /**
     * Create a RobloxFile from XML bytes.
     * @param buffer a data buffer
     * @returns a Roblox file object
     */
    public static ReadFromXmlBuffer(buffer: Uint8Array)
    {
        return new RobloxFileXMLReader().read(buffer);
    }

    /**
     * Create a RobloxFile from XML text.
     * @param xml XML text
     * @returns a Roblox file object
     */
    public static ReadFromXmlString(xml: string)
    {
        return new RobloxFileXMLReader().read(xml);
    }
}
