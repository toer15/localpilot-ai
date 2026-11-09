/// <reference types="vite/client" />
import type { LocalPilotApi } from '@shared/api'

declare global {
  interface Window {
    localpilot: LocalPilotApi
  }
}

export {}
