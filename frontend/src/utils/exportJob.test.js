// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runExportJob } from './exportJob'

describe('runExportJob', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('polls the job and downloads the completed file using its server filename', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:report-export'),
      revokeObjectURL: vi.fn(),
    }))
    const downloads = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      downloads.push(this.download)
    })
    const getJob = vi.fn()
      .mockResolvedValueOnce({ status: 'processing', total_rows: 5, processed_rows: 2 })
      .mockResolvedValueOnce({ status: 'completed', filename: 'Transfers.pdf' })
    const downloadJob = vi.fn().mockResolvedValue(new Blob(['pdf']))

    const result = runExportJob({
      createJob: vi.fn().mockResolvedValue({ job_id: 'job-1', status: 'queued' }),
      getJob,
      downloadJob,
      filename: 'fallback.pdf',
      preparingLabel: 'Preparing PDF export…',
      readyMessage: 'PDF export ready',
    })

    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toBe(true)
    expect(getJob).toHaveBeenCalledTimes(2)
    expect(downloadJob).toHaveBeenCalledWith('job-1')
    expect(downloads).toEqual(['Transfers.pdf'])
  })
})
