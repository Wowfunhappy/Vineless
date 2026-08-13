// Assembles the Safari legacy (.safariextension) build of Vineless.
//
// The extension logic in src/ is reused; only the platform glue differs. The
// three ES-module entry points (background, panel, file picker) are bundled by
// rollup into self-contained classic IIFE scripts so the build does not rely on
// ES module support over the safari-extension:// scheme. This script then lays
// out Vineless.safariextension/: the non-bundled assets from src/, the Safari
// glue from safari-src/ (chrome.* shim, injected script, global page,
// Info.plist), the rollup bundles, and patched HTML pages.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = import.meta.dirname;
const SRC = path.join(root, 'src');
const SAFARI_SRC = path.join(root, 'safari-src');
const TMP = path.join(root, 'build-safari-tmp');
const OUT = path.join(root, 'Vineless.safariextension');

// src/ paths that are replaced or folded into a bundle and must not be copied.
const SKIP_FILES = new Set([
    'manifest.json',        // Chrome manifest, replaced by Info.plist
    'message_proxy.js',     // replaced by the Safari version
    'content_script.js',    // embedded into message_proxy.js for inline injection
    'background.js',        // -> background.bundle.js
    'util.js',              // bundled
    'pages/panel/panel.js', // -> panel.bundle.js
]);
// lib/ is folded into the bundles. The picker page is omitted: it would open as
// a browser tab, which cannot reach the global page and therefore cannot store
// what it imports, so device import happens in the panel popover instead.
const SKIP_DIRS = new Set(['lib', 'pages/picker']);

function copyDir(from, to, relBase) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
        const srcPath = path.join(from, entry.name);
        const dstPath = path.join(to, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(rel)) continue;
            copyDir(srcPath, dstPath, rel);
        } else {
            if (SKIP_FILES.has(rel)) continue;
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

// The EME hooks redefine properties on DOM objects. Some of those properties are
// non-configurable in this WebKit, where a failed redefinition would throw and
// abort the whole hook script. Route the redefinitions through a helper that
// reports the failure and carries on, so one unavailable property does not take
// the rest of the hooks down with it.
function guardPropertyRedefinitions(source) {
    const helper = [
        '',
        '    // Installing the EME hooks twice would wrap them around themselves,',
        '    // sending a second license challenge for every session.',
        '    if (window.__vinelessHooksInstalled) {',
        '        return;',
        '    }',
        '    window.__vinelessHooksInstalled = true;',
        '',
        '    function __vlDefineProperty(target, prop, descriptor) {',
        '        try {',
        '            return Object["defineProperty"](target, prop, descriptor);',
        '        } catch (e) {',
        '            console.error("[Vineless] could not redefine \'" + prop + "\': " + e.message);',
        '            return target;',
        '        }',
        '    }',
        ''
    ].join('\n');

    const opener = '(function () {';
    if (!source.startsWith(opener)) {
        throw new Error('content_script.js does not start with the expected IIFE');
    }
    const guarded = source.slice(opener.length).split('Object.defineProperty(').join('__vlDefineProperty(');
    if (guarded.includes('Object.defineProperty(')) {
        throw new Error('content_script.js still has unguarded property redefinitions');
    }
    return opener + helper + guarded;
}

function patchFile(relPath, replacer) {
    const p = path.join(OUT, relPath);
    const original = fs.readFileSync(p, 'utf8');
    const patched = replacer(original);
    if (patched === original) {
        throw new Error(`Patch made no change: ${relPath}`);
    }
    fs.writeFileSync(p, patched);
}

function build() {
    // 1. Bundle the ES-module entry points into classic IIFE scripts.
    console.log('Bundling entry points with rollup...');
    execSync('node_modules/.bin/rollup -c rollup.safari.config.js', {
        cwd: root,
        stdio: 'inherit',
    });

    fs.rmSync(OUT, { recursive: true, force: true });

    // 2. Copy the non-bundled shared assets (html, css, images, content script).
    copyDir(SRC, OUT, '');

    // 3. Drop in the Safari glue.
    fs.mkdirSync(path.join(OUT, 'safari'), { recursive: true });
    fs.copyFileSync(path.join(SAFARI_SRC, 'shim.js'), path.join(OUT, 'safari', 'shim.js'));
    fs.copyFileSync(path.join(SAFARI_SRC, 'global.html'), path.join(OUT, 'global.html'));

    // message_proxy.js embeds the page-world hook source for inline injection.
    const proxyTemplate = fs.readFileSync(path.join(SAFARI_SRC, 'message_proxy.js'), 'utf8');
    const contentScript = fs.readFileSync(path.join(SRC, 'content_script.js'), 'utf8');
    if (!proxyTemplate.includes('__CONTENT_SCRIPT__')) {
        throw new Error('message_proxy.js is missing the __CONTENT_SCRIPT__ placeholder');
    }
    const proxyOut = proxyTemplate.replace(
        '__CONTENT_SCRIPT__',
        JSON.stringify(guardPropertyRedefinitions(contentScript))
    );
    fs.writeFileSync(path.join(OUT, 'message_proxy.js'), proxyOut);
    fs.copyFileSync(path.join(SAFARI_SRC, 'Info.plist'), path.join(OUT, 'Info.plist'));

    // 4. Place the bundles.
    fs.copyFileSync(path.join(TMP, 'background.bundle.js'), path.join(OUT, 'background.bundle.js'));
    fs.copyFileSync(path.join(TMP, 'panel.bundle.js'), path.join(OUT, 'pages', 'panel', 'panel.bundle.js'));
    fs.copyFileSync(path.join(TMP, 'import.bundle.js'), path.join(OUT, 'import.bundle.js'));

    // 5. Load the shim, then the classic bundle, in each extension page.
    const shimTag = '<script src="../../safari/shim.js"></script>';

    patchFile('pages/panel/panel.html', (s) =>
        s.replace(
            '<script type="module" src="panel.js" defer></script>',
            shimTag +
            '\n    <script src="../../import.bundle.js" defer></script>' +
            '\n    <script src="panel.bundle.js" defer></script>'
        )
    );
    patchFile('pages/errview/errview.html', (s) =>
        s.replace(
            '<script src="errview.js"></script>',
            shimTag + '\n        <script src="errview.js"></script>'
        )
    );

    console.log(`Built ${path.relative(root, OUT)}`);
}

build();
