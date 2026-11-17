# pi-extensions

Authoring repo for personal [Pi](https://pi.dev) coding-agent
extensions, packaged as Pi packages.

## extensions/

One directory per extension. Pi discovers `extensions/<name>/index.ts`
through the `pi.extensions` glob in the root `package.json`.

```text
extensions/
└── <name>/
    ├── index.ts        # default export: (pi: ExtensionAPI) => void
    ├── package.json    # only when the extension has runtime deps
    ├── LICENSE         # keep, when code came from an upstream package
    └── README.md       # what it does, how to enable it, options
```

Test loop:

```bash
pi -e ./extensions/<name>/index.ts      # single file, no settings entry
pi install ./code/pi-extensions         # whole repo as a local package
pi config                               # enable/disable resources
npm run typecheck
```
