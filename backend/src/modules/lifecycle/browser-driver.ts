import type { DriverResult } from './types';

export interface RegisterInput {
  email: string;
  password: string;
  phone: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LogoutInput {
  email: string;
}

export interface BookInput {
  accountEmail: string;
  firstName: string;
  lastName: string;
  passportNumber: string;
  dob: string;
  nationality: string;
  email: string;
  phone: string;
  subCategory: string;
}

export interface BrowserDriver {
  register(input: RegisterInput): Promise<DriverResult>;
  login(input: LoginInput): Promise<DriverResult>;
  logout(input: LogoutInput): Promise<DriverResult>;
  isReady(): Promise<boolean>;
  book(input: BookInput): Promise<DriverResult>;
}
