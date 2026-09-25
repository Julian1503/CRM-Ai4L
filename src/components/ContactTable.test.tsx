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
    subscribedToPrograms: true,
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
    subscribedToPrograms: true,
    position: 'Developer',
    organisation: { name: 'Beta Ltd' },
  },
];

describe('ContactTable UI Tests (TDD)', () => {
  it('shows the two email consents as separate columns', () => {
    // One column cannot answer for both: a contact who takes courses but not the
    // newsletter is a normal state, and a single "Subscribed" pill would have to pick
    // one of the two to be wrong about.
    render(
      <ContactTable
        contacts={mockContacts}
        onSelectContact={jest.fn()}
        onSort={jest.fn()}
        sortKey=""
        sortDir="asc"
      />
    );

    expect(screen.getByRole('columnheader', { name: /Newsletter/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Courses/ })).toBeInTheDocument();

    // John takes both; Alice takes courses only.
    expect(screen.getAllByText('Subscribed')).toHaveLength(3);
    expect(screen.getAllByText('Unsubscribed')).toHaveLength(1);
  });

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

describe('ContactTable row selection', () => {
  function renderSelectable(
    overrides: Partial<React.ComponentProps<typeof ContactTable>> = {}
  ) {
    const onToggleRow = jest.fn();
    const onTogglePage = jest.fn();

    render(
      <ContactTable
        contacts={mockContacts}
        onSelectContact={jest.fn()}
        onSort={jest.fn()}
        sortKey=""
        sortDir="asc"
        selectedIds={new Set<string>()}
        onToggleRow={onToggleRow}
        onTogglePage={onTogglePage}
        {...overrides}
      />
    );

    return { onToggleRow, onTogglePage };
  }

  it('renders no checkbox column when selection is not offered', () => {
    render(
      <ContactTable
        contacts={mockContacts}
        onSelectContact={jest.fn()}
        onSort={jest.fn()}
        sortKey=""
        sortDir="asc"
      />
    );

    expect(screen.queryByTestId('select-all-contacts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-contact-1')).not.toBeInTheDocument();
  });

  it('ticks a single row', () => {
    const { onToggleRow } = renderSelectable();

    fireEvent.click(screen.getByTestId('select-contact-1'));

    expect(onToggleRow).toHaveBeenCalledWith('1', true);
  });

  it('unticks a row that is already selected', () => {
    const { onToggleRow } = renderSelectable({ selectedIds: new Set(['1']) });

    expect(screen.getByTestId('select-contact-1')).toBeChecked();
    fireEvent.click(screen.getByTestId('select-contact-1'));

    expect(onToggleRow).toHaveBeenCalledWith('1', false);
  });

  it('does not open the drawer when the checkbox is clicked', () => {
    // Ticking a row and opening it are different intents sharing one row.
    const onSelectContact = jest.fn();
    renderSelectable({ onSelectContact });

    fireEvent.click(screen.getByTestId('select-contact-1'));

    expect(onSelectContact).not.toHaveBeenCalled();
  });

  it('selects every row on the current page from the header', () => {
    const { onTogglePage } = renderSelectable();

    fireEvent.click(screen.getByTestId('select-all-contacts'));

    expect(onTogglePage).toHaveBeenCalledWith(['1', '2'], true);
  });

  it('clears the page from the header once every row is selected', () => {
    const { onTogglePage } = renderSelectable({ selectedIds: new Set(['1', '2']) });

    expect(screen.getByTestId('select-all-contacts')).toBeChecked();
    fireEvent.click(screen.getByTestId('select-all-contacts'));

    expect(onTogglePage).toHaveBeenCalledWith(['1', '2'], false);
  });

  it('shows a partial page selection as indeterminate rather than checked', () => {
    renderSelectable({ selectedIds: new Set(['1']) });

    const selectAll = screen.getByTestId('select-all-contacts') as HTMLInputElement;

    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
  });

  it('marks a selected row so a selection made on another page stays visible', () => {
    renderSelectable({ selectedIds: new Set(['2']) });

    expect(screen.getByText('Alice Smith').closest('tr')).toHaveAttribute(
      'data-selected',
      'true'
    );
    expect(screen.getByText('John Doe').closest('tr')).not.toHaveAttribute('data-selected');
  });

  it('disables the header checkbox when there is nothing to select', () => {
    renderSelectable({ contacts: [] });

    expect(screen.getByTestId('select-all-contacts')).toBeDisabled();
  });
});
