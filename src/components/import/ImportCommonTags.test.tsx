import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import ImportCommonTags from './ImportCommonTags'

function Harness({ initial = [], onChange }: { initial?: string[]; onChange?: (names: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <ImportCommonTags
      value={value}
      onChange={(names) => {
        setValue(names)
        onChange?.(names)
      }}
    />
  )
}

const input = () => screen.getByTestId('import-common-tags-input')

describe('ImportCommonTags', () => {
  it('adds several tags separated by ";" with Enter', () => {
    const onChange = jest.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.change(input(), { target: { value: 'VIP; Workshop 2026' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(onChange).toHaveBeenLastCalledWith(['VIP', 'Workshop 2026'])
    expect(screen.getByRole('list', { name: 'Common tags' })).toHaveTextContent('VIP')
    expect(input()).toHaveValue('')
  })

  it('does not duplicate a tag already in the list, whatever its case', () => {
    const onChange = jest.fn()
    render(<Harness initial={['VIP']} onChange={onChange} />)

    fireEvent.change(input(), { target: { value: 'vip; New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(onChange).toHaveBeenLastCalledWith(['VIP', 'New'])
  })

  it('refuses a tag over the length limit with an explanation', () => {
    const onChange = jest.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.change(input(), { target: { value: 'z'.repeat(81) } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(screen.getByRole('alert')).toHaveTextContent(/longer than 80 characters/)
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses to go over 50 tags', () => {
    const onChange = jest.fn()
    const initial = Array.from({ length: 50 }, (_, index) => `t${index}`)
    render(<Harness initial={initial} onChange={onChange} />)

    fireEvent.change(input(), { target: { value: 'one more' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(screen.getByRole('alert')).toHaveTextContent(/at most 50/)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a tag', () => {
    const onChange = jest.fn()
    render(<Harness initial={['VIP', 'Workshop']} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove VIP' }))

    expect(onChange).toHaveBeenLastCalledWith(['Workshop'])
  })

  it('ignores an empty entry and clears the error once the text changes', () => {
    const onChange = jest.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.change(input(), { target: { value: ' ; ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(input(), { target: { value: 'q'.repeat(81) } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: 'ok' } })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
