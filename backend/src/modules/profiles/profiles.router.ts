import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '@middleware/auth.middleware';
import { validate } from '@middleware/validate.middleware';
import { createProfileSchema, updateProfileSchema } from './profiles.schema';
import {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  bulkUpload,
} from './profiles.controller';

const upload = multer({
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

export const profilesRouter = Router();

profilesRouter.use(requireAuth);

profilesRouter.get('/', listProfiles);
profilesRouter.get('/:id', getProfile);
profilesRouter.post('/', validate(createProfileSchema), createProfile);
profilesRouter.put('/:id', validate(updateProfileSchema), updateProfile);
profilesRouter.delete('/:id', deleteProfile);
profilesRouter.post('/bulk-upload', upload.single('file'), bulkUpload);
