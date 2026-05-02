import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const refreshSchema = z.object({
  // refresh token comes from httpOnly cookie, no body needed
});

export type LoginDto = z.infer<typeof loginSchema>;
