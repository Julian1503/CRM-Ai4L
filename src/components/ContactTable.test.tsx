import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ContactTable from './ContactTable';

const mockContacts = [
  {
    id: '1',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    isCustomer: true,
    subscribedToNewsletter: true,
    position: 'Manager',
    organisation: { name: 'Acme Corp' },
  },
  {
    id: '2',
    firstName: 'Alice',
    lastName: 'Smith',
    email: 'alice@example.com',
    isCustomer: false,
    subscribedToNewsletter: false,
    position: 'Developer',
    organisation: { name: 'Beta Ltd' },
  },
];

describe('ContactTable UI Tests (TDD)', () => {
  it('renders contacts list headers and rows correctly', () => {
    render(
      <ContactTable 
        contacts={mockContacts} 
        onSelectContact={jest.fn()} 
        onSort={jest.fn()} 
        sortKey="" 
        sortDir="asc"
      />
    );

    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Ltd')).toBeInTheDocument();
  });

  it('triggers sorting callback when table header is clicked', () => {
    const handleSort = jest.fn();
    render(
      <ContactTable 
        contacts={mockContacts} 
        onSelectContact={jest.fn()} 
        onSort={handleSort} 
        sortKey="name" 
        sortDir="asc"
      />
    );

    const nameHeader = screen.getByText(/name/i);
    fireEvent.click(nameHeader);
    expect(handleSort).toHaveBeenCalledWith('name');
  });

  it('triggers contact detail selection drawer on row click', () => {
    const handleSelect = jest.fn();
    render(
      <ContactTable 
        contacts={mockContacts} 
        onSelectContact={handleSelect} 
        onSort={jest.fn()} 
        sortKey="" 
        sortDir="asc"
      />
    );

    const contactRow = screen.getByText('John Doe').closest('tr');
    expect(contactRow).not.toBeNull();
    fireEvent.click(contactRow!);
    expect(handleSelect).toHaveBeenCalledWith(mockContacts[0]);
  });
});
