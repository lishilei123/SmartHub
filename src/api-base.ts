// The API prefix includes /api. The legacy Planning override remains a fallback
// so existing installations migrate all modules together to the shared origin.
export const apiBase = (import.meta.env?.VITE_API_BASE?.trim()
  || import.meta.env?.VITE_PLANNING_API_BASE?.trim()
  || '/api').replace(/\/+$/, '')
