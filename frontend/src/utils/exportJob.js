import toast from 'react-hot-toast'

const EXPORT_POLL_INTERVAL_MS = 1500
const EXPORT_POLL_TIMEOUT_MS = 20 * 60 * 1000

export async function runExportJob({
  createJob,
  getJob,
  downloadJob,
  filename,
  preparingLabel,
  readyMessage,
}) {
  const toastId = toast.loading(preparingLabel)
  try {
    const job = await createJob()
    const deadline = Date.now() + EXPORT_POLL_TIMEOUT_MS
    let status = job
    while (status.status !== 'completed' && status.status !== 'failed') {
      if (Date.now() > deadline) {
        throw new Error('The export is taking longer than expected. Please try again later.')
      }
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS))
      status = await getJob(job.job_id)
      if (status.status === 'processing' && status.total_rows) {
        toast.loading(
          `${preparingLabel} ${status.processed_rows} of ${status.total_rows} rows`,
          { id: toastId },
        )
      }
    }
    if (status.status !== 'completed') {
      throw new Error(status.error_message || 'Export failed.')
    }

    const blob = await downloadJob(job.job_id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = status.filename || filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    toast.success(readyMessage, { id: toastId })
    return true
  } catch (error) {
    if (error?.response) toast.dismiss(toastId)
    else toast.error(error?.message || 'Export failed.', { id: toastId })
    return false
  }
}
