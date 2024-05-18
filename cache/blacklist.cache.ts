import fs from 'fs';
import path from 'path';
import { logger, BLACKLIST_REFRESH_INTERVAL } from '../helpers';

export class BlacklistCache {
  private blacklist: string[] = [];
  private fileLocation = path.join(__dirname, '../storage/blacklist.txt');

  constructor() {
    setInterval(() => this.loadBlacklist(), BLACKLIST_REFRESH_INTERVAL);
  }

  public init() {
    this.loadBlacklist();
  }

  public isInList(mint: string) {
    return this.blacklist.includes(mint);
  }

  private loadBlacklist() {
    logger.trace(`Refreshing blacklist...`);

    const count = this.blacklist.length;
    const data = fs.readFileSync(this.fileLocation, 'utf-8');
    this.blacklist = data
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a);

    if (this.blacklist.length != count) {
      logger.info(`Loaded blacklist list: ${this.blacklist.length}`);
    }
  }
}
