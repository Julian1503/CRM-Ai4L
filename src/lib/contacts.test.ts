import { validateContact } from './contacts';

describe('Contact Validator Unit Tests (TDD)', () => {
  it('validates a correct contact successfully', () => {
    const validContact = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      isCustomer: true,
      servicesBought: ['service-1'],
      subscribedToNewsletter: true,
    };

    const result = validateContact(validContact);
    expect(result.isValid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('rejects contact if first name or last name is missing', () => {
    const invalidContact = {
      firstName: '',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      isCustomer: false,
      servicesBought: [],
      subscribedToNewsletter: false,
    };

    const result = validateContact(invalidContact);
    expect(result.isValid).toBe(false);
    expect(result.errors?.firstName).toContain('First Name is required');
  });

  it('rejects contact with malformed email', () => {
    const invalidContact = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'invalid-email-format',
      isCustomer: false,
      servicesBought: [],
      subscribedToNewsletter: false,
    };

    const result = validateContact(invalidContact);
    expect(result.isValid).toBe(false);
    expect(result.errors?.email).toContain('Invalid Email address');
  });

  it('clears servicesBought if contact is a prospect (not customer)', () => {
    const prospectWithServices = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      isCustomer: false,
      servicesBought: ['service-1'], // Should be empty for prospects
      subscribedToNewsletter: false,
    };

    const result = validateContact(prospectWithServices);
    expect(result.isValid).toBe(true);
    expect(result.sanitizedData?.servicesBought).toEqual([]);
  });
});
