export interface Config {
  port: number;
  databaseUrl: string;
  webhookSecret: string;
  expirySweepMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  const webhookSecret = required('PAYMENT_WEBHOOK_SECRET');
  if (webhookSecret.length < 16) {
    throw new Error('PAYMENT_WEBHOOK_SECRET must be at least 16 characters');
  }
  return {
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: required('DATABASE_URL'),
    webhookSecret,
    expirySweepMs: Number(process.env.EXPIRY_SWEEP_MS ?? 5000),
  };
}
