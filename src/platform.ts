import { platform as osPlatform } from 'node:os'
import type { Platform } from './types.js'

export function detectPlatform(): Platform {
  const p = osPlatform()
  if (p === 'darwin') return 'darwin'
  if (p === 'win32') return 'win32'
  if (p === 'linux') {
    if (process.env.WSL_DISTRO_NAME) return 'wsl2'
    return 'linux'
  }
  return 'linux'
}
