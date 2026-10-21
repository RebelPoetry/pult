// Типы для scripts/lsregister.mjs: юнит-тесты оболочки — TypeScript (test/unit/lsregister.test.ts).
export declare const LSREGISTER: string
export declare function isInstalledApp(app: string, home?: string): boolean
export declare function appsToUnregister(opts: { app: string; launched: boolean; created?: string[]; home?: string }): string[]
export type Exec = (file: string, args: string[], opts: object) => unknown
export declare function unregisterApps(paths: string[], exec?: Exec): Array<{ path: string; ok: boolean; error?: string }>
