// Bundles the Vineless entry points into self-contained classic (non-module)
// IIFE scripts for the Safari legacy build. This avoids relying on ES module
// support (and correct JS MIME types) for resources served over the
// safari-extension:// scheme, which is not guaranteed on Safari 7.
//
// The bundles reference `chrome` as a global, which the shim (safari/shim.js)
// installs on window before these scripts run.

const entries = [
    { input: 'src/background.js', file: 'build-safari-tmp/background.bundle.js' },
    { input: 'src/pages/panel/panel.js', file: 'build-safari-tmp/panel.bundle.js' },
    { input: 'safari-src/panel-import.js', file: 'build-safari-tmp/import.bundle.js' },
];

export default entries.map(({ input, file }) => ({
    input,
    output: {
        file,
        format: 'iife',
        inlineDynamicImports: true,
    },
    // The vendored *.min.js files are pre-built browser bundles; silence
    // rollup's circular-dependency chatter from the app's own modules.
    onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
    },
}));
