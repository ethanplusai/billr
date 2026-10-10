interface EstimateLineItemFormData {
  description: string
  quantity: number
  rate: number
}

export interface EstimateFormData {
  client_id: string
  issue_date: string
  expiry_date: string
  notes?: string
  terms?: string
  line_items: EstimateLineItemFormData[]
}
