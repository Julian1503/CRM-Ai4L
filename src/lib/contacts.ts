export interface ContactInput {
  firstName: string;
  lastName: string;
  preferredName?: string;
  email: string;
  mobileNumber?: string;
  workPhone?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  country?: string;
  organisationId?: string;
  department?: string;
  position?: string;
  notes?: string;
  isCustomer: boolean;
  servicesBought: string[];
  subscribedToNewsletter: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors?: Record<string, string>;
  sanitizedData?: ContactInput;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContact(input: Record<string, unknown>): ValidationResult {
  const errors: Record<string, string> = {};
  
  const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : '';
  const lastName = typeof input.lastName === 'string' ? input.lastName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';

  if (!firstName) {
    errors.firstName = 'First Name is required';
  }

  if (!lastName) {
    errors.lastName = 'Last Name is required';
  }

  if (!email) {
    errors.email = 'Email address is required';
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = 'Invalid Email address';
  }

  const isCustomer = !!input.isCustomer;
  
  // If contact is a Prospect (isCustomer === false), clear servicesBought
  const servicesBought = isCustomer && Array.isArray(input.servicesBought) 
    ? input.servicesBought 
    : [];

  const sanitizedData: ContactInput = {
    firstName,
    lastName,
    preferredName: typeof input.preferredName === 'string' ? input.preferredName.trim() : undefined,
    email,
    mobileNumber: typeof input.mobileNumber === 'string' ? input.mobileNumber.trim() : undefined,
    workPhone: typeof input.workPhone === 'string' ? input.workPhone.trim() : undefined,
    address: typeof input.address === 'string' ? input.address.trim() : undefined,
    suburb: typeof input.suburb === 'string' ? input.suburb.trim() : undefined,
    state: typeof input.state === 'string' ? input.state.trim() : undefined,
    postcode: typeof input.postcode === 'string' ? input.postcode.trim() : undefined,
    country: typeof input.country === 'string' ? input.country.trim() : undefined,
    organisationId: typeof input.organisationId === 'string' ? input.organisationId : undefined,
    department: typeof input.department === 'string' ? input.department.trim() : undefined,
    position: typeof input.position === 'string' ? input.position.trim() : undefined,
    notes: typeof input.notes === 'string' ? input.notes.trim() : undefined,
    isCustomer,
    servicesBought,
    subscribedToNewsletter: !!input.subscribedToNewsletter,
  };

  const isValid = Object.keys(errors).length === 0;

  return {
    isValid,
    errors: isValid ? undefined : errors,
    sanitizedData: isValid ? sanitizedData : undefined,
  };
}
