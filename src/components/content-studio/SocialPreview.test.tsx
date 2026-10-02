import { fireEvent, render, screen } from '@testing-library/react'

import SocialPreview, { type PreviewImage } from './SocialPreview'

const image = (id: string, url: string | null = `https://img.test/${id}.jpg`): PreviewImage => ({ id, url, alt: `Alt ${id}`, width: 1000, height: 1000 })

describe('SocialPreview', () => {
  it('renders the text verbatim with hashtags highlighted and the account name', () => {
    render(<SocialPreview platform="facebook" text={'Line one\n\nBook now #workshop'} images={[]} accountName="AI4L Page" />)

    expect(screen.getByText('Approximate preview · Facebook')).toBeInTheDocument()
    expect(screen.getByText('AI4L Page')).toBeInTheDocument()
    expect(screen.getByText('AP')).toBeInTheDocument()
    expect(screen.getByText('#workshop')).toBeInTheDocument()
  })

  it('folds long text behind the network’s more control', () => {
    const text = `${'word '.repeat(60)}end`
    render(<SocialPreview platform="linkedin" text={text} images={[]} />)

    expect(screen.queryByText(/end$/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '…see more' }))
    expect(screen.getByText(/end$/)).toBeInTheDocument()
    expect(screen.getByText('Your account')).toBeInTheDocument()
  })

  it('says when there is no text', () => {
    render(<SocialPreview platform="facebook" text="" images={[]} />)
    expect(screen.getByText('No text yet.')).toBeInTheDocument()
  })

  it('lays out a single photo and a mosaic with an overflow count', () => {
    const { rerender } = render(<SocialPreview platform="facebook" text="Hi" images={[image('a')]} />)
    expect(screen.getByRole('img', { name: 'Alt a' })).toBeInTheDocument()

    rerender(<SocialPreview platform="facebook" text="Hi" images={['a', 'b', 'c', 'd', 'e', 'f'].map((id) => image(id))} />)
    expect(screen.getAllByRole('img')).toHaveLength(4)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('shows an Instagram carousel that steps through images', () => {
    render(<SocialPreview platform="instagram" text="Caption" images={[image('a'), image('b', null)]} />)

    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('tells the operator Instagram needs an image', () => {
    render(<SocialPreview platform="instagram" text="Caption" images={[]} />)
    expect(screen.getByText('Instagram needs at least one image.')).toBeInTheDocument()
  })
})
