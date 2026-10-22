import type { Plugin } from "vite";

export type ExternalRule = string | RegExp;
export type ExternalOption = ExternalRule | ExternalRule[] |
  ((id: string, importer: string | undefined, isResolved: boolean) => boolean | null | undefined | void);

export interface RestartOptions {
  entry?: string;
  debounce?: number;
}

export interface DirftOptions {
  external?: ExternalOption;
  restart?: boolean | RestartOptions;
  lazy?: boolean;
  bundled?: string;
  /** Enable Node source maps for the application process. Defaults to false. */
  sourcemap?: boolean;
  entry?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export declare function dirft(options?: DirftOptions): Plugin;
export default dirft;
