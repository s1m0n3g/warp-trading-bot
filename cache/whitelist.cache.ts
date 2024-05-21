import fs from 'fs';
import path from 'path';
import { logger, WHITELIST_REFRESH_INTERVAL } from '../helpers';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer, MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';

export class WhitelistCache {
  private whitelist: string[] = [];
  private fileLocation = path.join(__dirname, '../storage/whitelist.txt');

  constructor() {
    setInterval(() => this.loadWhitelist(), WHITELIST_REFRESH_INTERVAL);
  }

  public init() {
    this.loadWhitelist();
  }

  public whitelistIsEmpty(){
    return this.whitelist.length == 0;
  }

  public async isInList(connection, poolKeys): Promise<boolean> {
    try {

      if (this.whitelistIsEmpty()) {
        return false;
      }

      let metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData> = getMetadataAccountDataSerializer();

      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await connection.getAccountInfo(metadataPDA.publicKey, connection.commitment);

      if (!metadataAccount?.data) {
        return false;
      }

      const deserialize = metadataSerializer.deserialize(metadataAccount.data);

      if (this.whitelist.includes(deserialize[0].updateAuthority.toString())) {
        logger.trace({ mint: poolKeys.baseMint }, `Whitelist -> ${deserialize[0].updateAuthority.toString()} is whitelisted!`);
        return true;
      }

      return false;

    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `Whitelist -> Failed to check whitelist`);
      return false;
    }
  }

  private loadWhitelist() {
    logger.trace(`Refreshing whitelist...`);

    const count = this.whitelist.length;
    const data = fs.readFileSync(this.fileLocation, 'utf-8');
    this.whitelist = data
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a);

    if (this.whitelist.length != count) {
      logger.info(`Loaded whitelist list: ${this.whitelist.length}`);
    }
  }
}
