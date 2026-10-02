import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import AssetLibrary, { MAX_UPLOAD_BYTES, checkFile } from './AssetLibrary'
import { POLL_INITIAL_MS } from './hooks'
import { bodyOf, errorResponse, jsonResponse, makeAsset, makeJob, routeFetch } from './testUtils'

const ASSETS = '/api/content-studio/assets'
const SIGNED = 'https://storage.test/upload/sign'

function renderLibrary(props: Partial<Parameters<typeof AssetLibrary>[0]> = {}) {
  const onReload = jest.fn()
  render(<AssetLibrary itemId="item-1" assets={[]} loading={false} error={null} onReload={onReload} {...props} />)
  return onReload
}

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

describe('checkFile', () => {
  it('hints at type, size and emptiness', () => {
    expect(checkFile(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/not a JPEG/)
    const big = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 })
    expect(checkFile(big)).toMatch(/larger than 15 MB/)
    expect(checkFile(new File([], 'e.png', { type: 'image/png' }))).toMatch(/empty/)
    expect(checkFile(new File(['x'], 'ok.webp', { type: 'image/webp' }))).toBeNull()
  })
})

describe('AssetLibrary', () => {
  it('lists assets with status, origin, size and rejection reasons', () => {
    routeFetch({})
    renderLibrary({
      assets: [
        makeAsset(),
        makeAsset({ id: 'a2', origin: 'generated', originalFilename: null, generationPrompt: 'A sunny room', width: null, height: null, previewUrl: null, ingestStatus: 'pending' }),
        makeAsset({ id: 'a3', originalFilename: 'broken.jpg', ingestStatus: 'rejected', rejectionReason: 'Corrupt file' }),
        makeAsset({ id: 'a4', originalFilename: 'odd.jpg', ingestStatus: 'rejected', rejectionReason: null }),
      ],
    })

    expect(screen.getByText('workshop.jpg')).toBeInTheDocument()
    expect(screen.getAllByText('1200×800')).toHaveLength(3)
    expect(screen.getByText('A sunny room')).toBeInTheDocument()
    expect(screen.getByText('Generated')).toBeInTheDocument()
    expect(screen.getByText('Processing')).toBeInTheDocument()
    expect(screen.getByText('Corrupt file')).toBeInTheDocument()
    expect(screen.getByText('Rejected without a reason.')).toBeInTheDocument()
  })

  it('shows loading, empty and error states and refreshes', () => {
    routeFetch({})
    const { unmount } = render(<AssetLibrary itemId="i" assets={[]} loading error={null} onReload={jest.fn()} />)
    expect(screen.getByText('Loading images…')).toBeInTheDocument()
    unmount()

    const onReload = renderLibrary({ error: new Error('Storage down') })
    expect(screen.getByRole('alert')).toHaveTextContent('Storage down')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onReload).toHaveBeenCalled()
  })

  it('says when there are no images', () => {
    routeFetch({})
    renderLibrary()
    expect(screen.getByText(/No images yet/)).toBeInTheDocument()
  })

  it('uploads to the signed URL, starts ingest and follows the job', async () => {
    jest.useFakeTimers()
    try {
      const mock = routeFetch({
        [`POST ${ASSETS}`]: jsonResponse({ asset: makeAsset({ id: 'new' }), upload: { signedUrl: SIGNED, token: 't', path: 'p' } }, 201),
        [`PUT ${SIGNED}`]: jsonResponse({}),
        [`POST ${ASSETS}/new/ingest`]: jsonResponse({ job: makeJob({ id: 'ingest-1', kind: 'ingest_asset', status: 'queued' }) }, 202),
        ['GET /api/content-studio/jobs/ingest-1']: jsonResponse({ job: makeJob({ id: 'ingest-1', kind: 'ingest_asset', status: 'succeeded' }) }),
      })
      const onReload = renderLibrary()
      const file = new File(['bytes'], 'photo.png', { type: 'image/png' })

      fireEvent.click(screen.getByRole('button', { name: 'Upload image' }))
      pickFile(file)

      expect(await screen.findByText('Processing photo.png')).toBeInTheDocument()
      expect(bodyOf(mock, 'POST', ASSETS)).toEqual({ filename: 'photo.png', mimeType: 'image/png', byteSize: 5, itemId: 'item-1' })
      expect(mock.mock.calls.find(([url]) => url === SIGNED)?.[1].body).toBe(file)
      expect(onReload).toHaveBeenCalledTimes(1)

      await act(async () => {
        jest.advanceTimersByTime(POLL_INITIAL_MS)
      })
      await waitFor(() => expect(onReload).toHaveBeenCalledTimes(2))
      expect(screen.getByText('Done')).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('refuses a bad file locally and reports a failed upload', async () => {
    const mock = routeFetch({ [`POST ${ASSETS}`]: errorResponse(413, 'Too large for the server') })
    renderLibrary()

    pickFile(new File(['x'], 'a.gif', { type: 'image/gif' }))
    expect(screen.getByRole('alert')).toHaveTextContent('not a JPEG')
    expect(mock).not.toHaveBeenCalled()

    pickFile(new File(['x'], 'a.png', { type: 'image/png' }))
    expect(await screen.findByText('Too large for the server')).toBeInTheDocument()
  })

  it('ignores an empty file selection', () => {
    const mock = routeFetch({})
    renderLibrary()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('generates images with a prompt and count', async () => {
    const mock = routeFetch({
      ['POST /api/content-studio/items/item-1/images']: jsonResponse({ job: makeJob({ id: 'img-1', kind: 'generate_image', status: 'queued' }) }, 202),
    })
    renderLibrary()

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Describe the image')

    fireEvent.change(screen.getByLabelText('Generate images'), { target: { value: 'A bright room' } })
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(await screen.findByText('Generating: A bright room')).toBeInTheDocument()
    expect(bodyOf(mock, 'POST', '/api/content-studio/items/item-1/images')).toMatchObject({ prompt: 'A bright room', count: 3 })
    expect(screen.getByLabelText('Generate images')).toHaveValue('')
  })

  it('reports a failed image generation', async () => {
    routeFetch({ ['POST /api/content-studio/items/item-1/images']: errorResponse(503, 'Image model offline') })
    renderLibrary()
    fireEvent.change(screen.getByLabelText('Generate images'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('Image model offline')).toBeInTheDocument()
  })

  it('resumes following a pending asset from its active job', async () => {
    jest.useFakeTimers()
    try {
      routeFetch({ ['GET /api/content-studio/jobs/job-9']: jsonResponse({ job: makeJob({ id: 'job-9', kind: 'ingest_asset', status: 'succeeded' }) }) })
      const onReload = renderLibrary({ assets: [makeAsset({ ingestStatus: 'pending', activeJobId: 'job-9' })] })

      expect(screen.getByText('Processing workshop.jpg')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Process .* again/ })).not.toBeInTheDocument()
      await act(async () => {
        jest.advanceTimersByTime(POLL_INITIAL_MS)
      })
      await waitFor(() => expect(onReload).toHaveBeenCalled())
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not follow a job another panel already shows', () => {
    routeFetch({})
    renderLibrary({ assets: [makeAsset({ ingestStatus: 'pending', activeJobId: 'job-9' })], knownJobIds: ['job-9'] })
    expect(screen.queryByText('Processing workshop.jpg')).not.toBeInTheDocument()
  })

  it('processes a stalled pending asset again', async () => {
    const mock = routeFetch({
      [`POST ${ASSETS}/asset-1/ingest`]: jsonResponse({ job: makeJob({ id: 'ing-2', kind: 'ingest_asset', status: 'queued', assetId: 'asset-1' }) }, 202),
    })
    const onReload = renderLibrary({ assets: [makeAsset({ ingestStatus: 'pending', activeJobId: null })] })

    expect(screen.getByText('Processing stopped before it finished.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Process workshop.jpg again' }))

    expect(await screen.findByText('Processing workshop.jpg')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Process workshop.jpg again' })).not.toBeInTheDocument()
    expect(onReload).toHaveBeenCalled()
    expect(mock.mock.calls[0][0]).toBe(`${ASSETS}/asset-1/ingest`)
  })

  it('explains when the asset was already processed, or processing cannot start', async () => {
    const responses = [errorResponse(409, 'Not pending', 'asset_not_pending'), errorResponse(500, 'Queue down')]
    routeFetch({ [`POST ${ASSETS}/asset-1/ingest`]: () => responses.shift() ?? jsonResponse({}) })
    const onReload = renderLibrary({ assets: [makeAsset({ ingestStatus: 'pending', activeJobId: null })] })

    fireEvent.click(screen.getByRole('button', { name: 'Process workshop.jpg again' }))
    expect(await screen.findByText(/has already been processed/)).toBeInTheDocument()
    expect(onReload).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Process workshop.jpg again' }))
    expect(await screen.findByText('Queue down')).toBeInTheDocument()
  })
})
