/** VFS Mobile API request/response shapes. Refine after capture. */

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
  expiresIn: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  countryCode?: string;
}

export interface RegisterResponse {
  userId: string;
  emailVerificationRequired: boolean;
  phoneVerificationRequired: boolean;
}

export interface SlotQueryRequest {
  sourceCountry: string;     // 'UZB'
  destination: string;       // 'LVA'
  visaCategory: string;      // 'SCH'
  centreCode?: string;       // optional
}

export interface SlotInfo {
  slotId: string;
  date: string;              // 'YYYY-MM-DD'
  time?: string;             // 'HH:MM'
  centreCode: string;
  available: boolean;
}

export interface SlotQueryResponse {
  availableSlots: SlotInfo[];
  totalCount: number;
}

export interface BookingRequest {
  slotId: string;
  applicants: ApplicantData[];
  visaCategory: string;
}

export interface ApplicantData {
  fullName: string;
  passportNumber: string;
  dob: string;               // 'YYYY-MM-DD'
  passportExpiry: string;
  passportIssueDate?: string;
  nationality: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  email: string;
  phone: string;
}

export interface BookingResponse {
  bookingId: string;
  confirmationNumber: string;
  appointmentDate: string;
  appointmentTime: string;
  centreCode: string;
  status: 'CONFIRMED' | 'PENDING' | 'FAILED';
}

export interface VfsMobileError {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
}
