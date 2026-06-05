import toast from 'react-hot-toast'
import { exportDashboardApi } from '../api/dashboardApi'

export async function exportDashboard({ tab, format, filters }) {
  const response = await exportDashboardApi({ tab, format, filters })
  toast.success(`Export queued: ${response.job_id}`)
  return response
}
