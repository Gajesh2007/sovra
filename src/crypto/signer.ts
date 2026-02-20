import { mnemonicToAccount, type HDAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'

export class ContentSigner {
  private account: HDAccount
  readonly address: string

  constructor(mnemonic: string) {
    this.account = mnemonicToAccount(mnemonic)
    this.address = this.account.address
  }

  async sign(content: string): Promise<string> {
    return this.account.signMessage({ message: content })
  }

  static async verify(content: string, signature: string, address: string): Promise<boolean> {
    return verifyMessage({
      address: address as `0x${string}`,
      message: content,
      signature: signature as `0x${string}`,
    })
  }
}
