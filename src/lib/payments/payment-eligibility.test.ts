import { describe, it, expect } from 'vitest';
import { checkPaymentEligibility } from './payment-eligibility';

describe('Payment Eligibility Validator (SMM / Edgar vs Third-party)', () => {
  it('deve aprovar transações com external_id de SMM (smm_...)', async () => {
    const res = await checkPaymentEligibility(null, {
      paymentId: 'pay_123',
      externalId: 'smm_order_1792113649920_abc',
      buyer: { name: 'Cliente SMM', phone: '5511999998888' },
    });

    expect(res.isEligible).toBe(true);
    expect(res.isSmmOrEdgarProduct).toBe(true);
    expect(res.matchedBy).toBe('external_id');
  });

  it('deve aprovar transações com external_id de Apoio VIP Edgar Katsumi', async () => {
    const res = await checkPaymentEligibility(null, {
      paymentId: 'pay_456',
      externalId: 'apoiovip_edgar_1792113649920_xyz',
      buyer: { name: 'Apoiador VIP' },
    });

    expect(res.isEligible).toBe(true);
    expect(res.isSmmOrEdgarProduct).toBe(true);
    expect(res.matchedBy).toBe('external_id');
  });

  it('deve aprovar transações onde o nome da oferta/produto menciona SMM ou Edgar Katsumi', async () => {
    const res = await checkPaymentEligibility(null, {
      paymentId: 'pay_789',
      externalId: 'generic_uuid_123',
      offer: { name: 'SMM 1000 Seguidores Instagram' },
      buyer: { name: 'Comprador' },
    });

    expect(res.isEligible).toBe(true);
    expect(res.isSmmOrEdgarProduct).toBe(true);
    expect(res.matchedBy).toBe('product_name');
  });

  it('deve REJEITAR produtos externos que não sejam do Edgar/SMM (ex: Close Friends Mensal)', async () => {
    const res = await checkPaymentEligibility(null, {
      paymentId: '48609d42-f6a1-4203-9f5d-ce1d124e0bf1',
      offer: { name: 'Close Friends Mensal' },
      buyer: {
        name: 'Eduardo Silva ',
        email: 'oeduardosilva@icloud.com',
        phone: null,
      },
    });

    expect(res.isEligible).toBe(false);
    expect(res.isSmmOrEdgarProduct).toBe(false);
    expect(res.isExistingCrmClient).toBe(false);
    expect(res.reason).toContain('Close Friends');
  });

  it('deve REJEITAR produtos de outras lojas sem assinatura de SMM/Edgar', async () => {
    const res = await checkPaymentEligibility(null, {
      paymentId: 'pay_random_store',
      externalId: 'store_item_999',
      product: { name: 'Curso de Culinária Fitness' },
      buyer: { name: 'Desconhecido', phone: '5541999990000' },
    });

    expect(res.isEligible).toBe(false);
    expect(res.isSmmOrEdgarProduct).toBe(false);
  });
});
