import { fireEvent, render, screen } from '@testing-library/react'

import { analyseHeaders, emptyColumnMapping, type ColumnMapping } from '@/lib/contacts/columnMapping'

import ImportMappingStatus from './ImportMappingStatus'

function mapped(fields: Partial<ColumnMapping>): ColumnMapping {
  return { ...emptyColumnMapping(), ...fields }
}

describe('ImportMappingStatus', () => {
  it('names the concrete requirement that is missing', () => {
    render(<ImportMappingStatus mapping={mapped({ email: 'Email', firstName: 'First' })} />)

    const status = screen.getByTestId('import-missing-requirements')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('Before you can preview this import')
    expect(status).toHaveTextContent('map Last Name (for Email + First Name + Last Name)')
    expect(status).toHaveTextContent('map Full Name (Split) (for Email + Full Name)')
  })

  it('reports a missing email on its own', () => {
    render(<ImportMappingStatus mapping={mapped({ fullName: 'Name' })} />)

    expect(screen.getByTestId('import-missing-requirements')).toHaveTextContent(
      'Email Address is not mapped. Every import needs it.'
    )
  })

  it('confirms a complete mapping', () => {
    render(<ImportMappingStatus mapping={mapped({ email: 'Email', fullName: 'Name' })} />)

    expect(screen.getByTestId('import-missing-requirements')).toHaveTextContent('Required columns are mapped.')
  })

  it('asks for an explicit choice on an Industry column and maps it only when chosen', () => {
    const { mapping, ambiguous } = analyseHeaders(['Email', 'Name', 'Industry'])
    const onMapColumn = jest.fn()
    render(<ImportMappingStatus mapping={mapping} ambiguous={ambiguous} onMapColumn={onMapColumn} />)

    const notice = screen.getByTestId('import-ambiguous-columns')
    expect(notice).toHaveTextContent('“Industry” was not mapped automatically')
    expect(notice).toHaveTextContent(/organisation's sector/)
    expect(mapping.jobTypeName).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Use “Industry” as Job Type' }))
    expect(onMapColumn).toHaveBeenCalledWith('jobTypeName', 'Industry')
  })

  it('shows the choice once the operator made it', () => {
    const { mapping, ambiguous } = analyseHeaders(['Email', 'Name', 'Sector'])
    render(
      <ImportMappingStatus
        mapping={{ ...mapping, jobTypeName: 'Sector' }}
        ambiguous={ambiguous}
        onMapColumn={jest.fn()}
      />
    )

    expect(screen.getByTestId('import-ambiguous-columns')).toHaveTextContent('is mapped to Job Type by your choice')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders no ambiguity notice when there is nothing to decide', () => {
    render(<ImportMappingStatus mapping={emptyColumnMapping()} />)

    expect(screen.queryByTestId('import-ambiguous-columns')).not.toBeInTheDocument()
  })
})
