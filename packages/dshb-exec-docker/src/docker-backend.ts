export interface DockerBackend {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
  execShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: Buffer | string): Promise<void>
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>>
  stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  rename(src: string, dest: string): Promise<void>
  ensureRg(): Promise<void>
  pty(argv: string[], cwd: string, cols: number, rows: number): Promise<{ stream: NodeJS.ReadWriteStream; resize: (c: number, r: number) => void; kill: () => void }>
}

export interface HostCommandRunner {
  run(argv: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>
}
