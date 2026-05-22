import { z } from 'zod';

export const createProfileSchema = z.object({
  fullName: z.string().min(2),
  passportNumber: z.string().min(5),
  dob: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  passportExpiry: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  nationality: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).default('MALE'),
  passportIssueDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  vfsPassword: z.string().min(1).optional(),
  telegramChatId: z.string().optional(),
  priority: z.enum(['HIGH', 'NORMAL']).default('NORMAL'),
});

export const onboardProfileSchema = createProfileSchema
  .omit({ priority: true, vfsPassword: true, telegramChatId: true })
  .extend({
    destination: z.string().min(2).max(80),
    preferredStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    preferredEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    paymentMethod: z.string().min(2).max(80).default('Operator follow-up'),
  })
  .refine((data) => data.preferredEndDate >= data.preferredStartDate, {
    path: ['preferredEndDate'],
    message: 'Preferred end date must be on or after preferred start date',
  });

export const updateProfileSchema = createProfileSchema.partial();

export const updateProfileAccountsSchema = z.object({
  accountIds: z.array(z.string().uuid()).default([]),
});

export const submitOtpSchema = z.object({
  otp: z.string().regex(/^\d{4,8}$/, 'OTP must be 4-8 digits'),
});

export const profileIdSchema = z.object({
  id: z.string().cuid(),
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  priority: z.enum(['HIGH', 'NORMAL']).optional(),
});

export type CreateProfileDto = z.infer<typeof createProfileSchema>;
export type OnboardProfileDto = z.infer<typeof onboardProfileSchema>;
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
export type UpdateProfileAccountsDto = z.infer<typeof updateProfileAccountsSchema>;
export type SubmitOtpDto = z.infer<typeof submitOtpSchema>;
