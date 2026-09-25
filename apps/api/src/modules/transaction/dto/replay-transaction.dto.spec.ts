import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ReplayTransactionDto } from './replay-transaction.dto';

describe('ReplayTransactionDto', () => {
  it('accepts a request without legacy fields', async () => {
    const dto = plainToInstance(ReplayTransactionDto, {
      transactionHash: 'a'.repeat(64),
      network: 'testnet',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a request that supplies a secretKey', async () => {
    const dto = plainToInstance(ReplayTransactionDto, {
      transactionHash: 'a'.repeat(64),
      secretKey: 'SA'.padEnd(56, 'A'),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'secretKey')).toBe(true);
  });

  it('rejects a request that supplies submit', async () => {
    const dto = plainToInstance(ReplayTransactionDto, {
      transactionHash: 'a'.repeat(64),
      submit: true,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'submit')).toBe(true);
  });
});
