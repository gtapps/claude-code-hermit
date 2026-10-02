// Preloaded with `bun --preload` so a spawned script takes its darwin branch on a
// Linux CI host. process.platform is a getter, so plain assignment is a silent
// no-op; defineProperty is what actually takes.
Object.defineProperty(process, 'platform', { value: 'darwin' });
