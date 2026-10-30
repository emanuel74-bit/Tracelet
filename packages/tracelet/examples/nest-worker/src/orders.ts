import { Inject, Injectable } from '@nestjs/common';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface OrderMessage {
  id: string;
  skus: string[];
  /** Makes the price lookup fail, so the message is nacked. */
  poison?: boolean;
}

/** Plain Nest providers: no Tracelet imports. TraceletInstrument traces their methods automatically. */
@Injectable()
export class PriceRepository {
  async lookup(sku: string, poison = false): Promise<number> {
    await sleep(3);
    if (poison) throw new Error('price service unavailable (mongodb://svc:s3cr3t@db.internal:27017)');
    return sku.length * 100;
  }
}

@Injectable()
export class OrdersService {
  constructor(@Inject(PriceRepository) private readonly prices: PriceRepository) {}

  async total(message: OrderMessage): Promise<number> {
    const prices = await Promise.all(message.skus.map(sku => this.prices.lookup(sku, message.poison === true)));
    return prices.reduce((sum, p) => sum + p, 0);
  }
}
