const hideSpawnedWindowsSource = [
  "import childProcess from'node:child_process';",
  "const marker=Symbol.for('smarthub.windowsHideChildProcesses');",
  'if(!childProcess[marker]){',
  'const spawn=childProcess.spawn.bind(childProcess);',
  'childProcess.spawn=(command,args,options)=>Array.isArray(args)',
  '?spawn(command,args,{...options,windowsHide:true})',
  ':spawn(command,{...(args??{}),windowsHide:true});',
  'Object.defineProperty(childProcess,marker,{value:true});',
  '}',
].join('')

const hideSpawnedWindowsOption = `--import=data:text/javascript,${encodeURIComponent(hideSpawnedWindowsSource)}`

/**
 * Node's own windowsHide option does not cover a dependency that later starts
 * a detached Node daemon. Preload a narrow child_process wrapper into the
 * Playwright process tree so every descendant spawn keeps CREATE_NO_WINDOW.
 */
export function withWindowsHiddenNodeChildren(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'win32') return { ...environment }
  const existing = environment.NODE_OPTIONS?.trim()
  return {
    ...environment,
    NODE_OPTIONS: existing?.includes(hideSpawnedWindowsOption)
      ? existing
      : [existing, hideSpawnedWindowsOption].filter(Boolean).join(' '),
  }
}

