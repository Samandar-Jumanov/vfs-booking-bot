import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@middleware/auth.middleware';
import { validate } from '@middleware/validate.middleware';
import {
  createProfileSchema,
  onboardProfileSchema,
  submitOtpSchema,
  updateProfileAccountsSchema,
  updateProfileSchema,
} from './profiles.schema';
import {
  listProfiles,
  getProfile,
  createProfile,
  onboardProfile,
  updateProfile,
  deleteProfile,
  bulkUpload,
  extractPassport,
  submitOtp,
  updateProfileAccounts,
} from './profiles.controller';

const bulkUploadStorage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

const passportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype));
  },
});

export const profilesRouter = Router();

profilesRouter.post('/extract-passport', passportUpload.single('file'), extractPassport);
profilesRouter.post('/onboard', validate(onboardProfileSchema), onboardProfile);

profilesRouter.use(requireAuth);

profilesRouter.get('/', listProfiles);
profilesRouter.get('/:id', getProfile);
profilesRouter.post('/', validate(createProfileSchema), createProfile);
profilesRouter.post('/:id/submit-otp', validate(submitOtpSchema), submitOtp);
profilesRouter.put('/:id/accounts', validate(updateProfileAccountsSchema), updateProfileAccounts);
profilesRouter.put('/:id', validate(updateProfileSchema), updateProfile);
profilesRouter.delete('/:id', deleteProfile);
profilesRouter.post('/bulk-upload', bulkUploadStorage.single('file'), bulkUpload);
