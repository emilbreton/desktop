import { spawn } from 'child_process'
import * as os from 'os'
import * as Path from 'path'
import * as fs from 'fs'

import { TypedBaseStore } from './base-store'
import { mkdirIfNeeded } from '../file-system'

import {
  TroubleshootingState,
  TroubleshootingStep,
  ValidateHostAction,
} from '../../models/ssh'
import { Repository } from '../../models/repository'
import {
  getSSHEnvironment,
  isHostVerificationError,
  isPermissionError,
  executeSSHTest,
} from '../ssh'

export class TroubleshootingStore extends TypedBaseStore<TroubleshootingState | null> {
  private state: TroubleshootingState | null = null

  public constructor() {
    super()

    this.reset()
  }

  /**
   * Update the internal state of the store and emit an update
   * event.
   */
  private setState(state: TroubleshootingState | null) {
    this.state = state
    this.emitUpdate(this.getState())
  }

  /**
   * Returns the current state of the sign in store or null if
   * no sign in process is in flight.
   */
  public getState(): TroubleshootingState | null {
    return this.state
  }

  public reset() {
    this.setState({ kind: TroubleshootingStep.InitialState, isLoading: false })
  }

  public async validateHost(state: ValidateHostAction) {
    const nextState = { ...state, isLoading: true }
    this.setState(nextState)

    const sshDir = Path.join(os.homedir(), '.ssh')
    await mkdirIfNeeded(sshDir)

    await this.verifyHost(state)

    // TODO: how to resolve this from the repository?
    // TODO: how to resolve the host for GHE environments?
    const sshUrl = 'git@github.com'
    await this.validate(sshUrl)
  }

  public async start(repository: Repository) {
    this.setState({ kind: TroubleshootingStep.InitialState, isLoading: true })

    // TODO: how to resolve this from the repository?
    // TODO: how to resolve the host for GHE environments?
    const sshUrl = 'git@github.com'
    await this.validate(sshUrl)
  }

  private verifyHost = async (state: ValidateHostAction) => {
    const homeDir = os.homedir()

    const command = 'ssh-keyscan'
    const env = await getSSHEnvironment(command)

    return new Promise<void>((resolve, reject) => {
      const keyscan = spawn(command, [state.host], { shell: true, env })
      const knownHostsPath = Path.join(homeDir, '.ssh', 'known_hosts')

      keyscan.stdout.pipe(fs.createWriteStream(knownHostsPath))

      keyscan.on('error', err => {
        // TODO: need to end up in the "I give up" part of the flow
        log.warn(`unable to spawn ssh-keyscan`, err)
      })

      keyscan.on('close', code => {
        if (code !== 0) {
          reject(
            new Error(
              `ssh-keyscan exited with code '${code}' while adding '${
                state.host
              }' which was not expected`
            )
          )
          return
        }
        resolve()
      })
    })
  }

  private async validate(sshUrl: string) {
    const stderr = await executeSSHTest(sshUrl)

    const verificationError = isHostVerificationError(stderr)
    if (verificationError !== null) {
      const { rawOutput, host } = verificationError
      this.setState({
        kind: TroubleshootingStep.ValidateHost,
        rawOutput,
        host,
        isLoading: false,
      })
      return
    }

    if (isPermissionError(stderr)) {
      // TODO: find accounts listed using ssh-add -l
      const accounts: ReadonlyArray<{
        file: string
        emailAddress: string
      }> = []

      this.setState({
        kind: TroubleshootingStep.NoAccount,
        foundAccounts: accounts,
      })
      return
    }

    this.setState({
      kind: TroubleshootingStep.Unknown,
      error: stderr,
    })
  }
}