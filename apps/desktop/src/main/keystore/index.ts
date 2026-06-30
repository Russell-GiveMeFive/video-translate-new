import keytar from 'keytar'
import type { KeyName } from '@dramaprime/core-types'

const SERVICE = 'DramaPrime'

export class Keystore {
  static get(key: KeyName): Promise<string | null> {
    return keytar.getPassword(SERVICE, key)
  }
  static set(key: KeyName, value: string): Promise<void> {
    return keytar.setPassword(SERVICE, key, value)
  }
  static delete(key: KeyName): Promise<boolean> {
    return keytar.deletePassword(SERVICE, key)
  }
}
