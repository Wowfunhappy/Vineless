// Device-file import for the Safari build, running inside the panel popover.
//
// Extension pages opened as browser tabs live in the web content process and
// cannot reach the global page, so anything they write to storage is invisible
// to the rest of the extension. The popover shares the extension process, so
// imports are performed there instead and this exposes the entry point the
// shim calls when a "Choose File" button is pressed.

import { SettingsManager } from "../src/util.js";

// Ordered so the permissive validator runs last: .prd files are accepted with
// only loose checks, so stricter formats must be attempted first.
const IMPORTERS = [
    ["remote", SettingsManager.loadRemoteCDM],
    ["wvd", SettingsManager.importDevice],
    ["prd", SettingsManager.importPRDevice],
];

window.__vlImportDeviceFile = async function (file) {
    for (const [type, importFn] of IMPORTERS) {
        try {
            await importFn(file);
            console.log(`[Vineless] Imported ${file.name} as ${type}`);
            return true;
        } catch (e) {
            console.warn(`[Vineless] Failed to import ${file.name} as ${type}:`, e);
        }
    }
    return false;
};
