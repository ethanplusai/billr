'use client'

import { Trash2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { createEmptyLineItem, calculateLineItemAmount } from '@/lib/utils/invoice'
import type { LineItemFormData } from '@/lib/validations/invoice'

interface LineItemsEditorProps {
  items: LineItemFormData[]
  onChange: (items: LineItemFormData[]) => void
  currency?: string
}

export function LineItemsEditor({ items, onChange, currency = 'USD' }: LineItemsEditorProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  }

  const handleItemChange = (index: number, field: keyof LineItemFormData, value: string | number) => {
    const newItems = [...items]
    newItems[index] = {
      ...newItems[index],
      [field]: value,
    }

    // Recalculate amounts
    if (['quantity', 'rate', 'tax_rate', 'discount_percent'].includes(field)) {
      newItems[index] = calculateLineItemAmount(newItems[index])
    }

    onChange(newItems)
  }

  const addItem = () => {
    onChange([...items, createEmptyLineItem()])
  }

  const removeItem = (index: number) => {
    if (items.length <= 1) return
    const newItems = items.filter((_, i) => i !== index)
    onChange(newItems)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="hidden md:grid md:grid-cols-12 md:gap-4 text-sm font-medium text-muted-foreground">
        <div className="col-span-5">Description</div>
        <div className="col-span-2 text-right">Qty</div>
        <div className="col-span-2 text-right">Rate</div>
        <div className="col-span-2 text-right">Amount</div>
        <div className="col-span-1"></div>
      </div>

      {/* Items */}
      <div className="space-y-4">
        {items.map((item, index) => (
          <div
            key={item.id}
            className="group rounded-lg border bg-card p-4 md:p-0 md:border-0 md:bg-transparent"
          >
            {/* Mobile Layout */}
            <div className="md:hidden space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <Textarea
                  value={item.description}
                  onChange={(e) => handleItemChange(index, 'description', e.target.value)}
                  placeholder="Item description"
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Qty</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={item.quantity}
                    onChange={(e) => handleItemChange(index, 'quantity', parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Rate</label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.rate}
                    onChange={(e) => handleItemChange(index, 'rate', parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Amount</label>
                  <div className="flex h-10 items-center rounded-md border bg-muted px-3 text-sm">
                    {formatCurrency(item.amount)}
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeItem(index)}
                  disabled={items.length <= 1}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove
                </Button>
              </div>
            </div>

            {/* Desktop Layout */}
            <div className="hidden md:grid md:grid-cols-12 md:gap-4 md:items-start">
              <div className="col-span-5">
                <Textarea
                  value={item.description}
                  onChange={(e) => handleItemChange(index, 'description', e.target.value)}
                  placeholder="Item description"
                  rows={1}
                  className="min-h-10 resize-none"
                />
              </div>
              <div className="col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={item.quantity}
                  onChange={(e) => handleItemChange(index, 'quantity', parseFloat(e.target.value) || 0)}
                  className="text-right"
                />
              </div>
              <div className="col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.rate}
                  onChange={(e) => handleItemChange(index, 'rate', parseFloat(e.target.value) || 0)}
                  className="text-right"
                />
              </div>
              <div className="col-span-2 flex h-10 items-center justify-end text-sm font-medium tabular-nums">
                {formatCurrency(item.amount)}
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(index)}
                  disabled={items.length <= 1}
                  className={cn(
                    'opacity-0 transition-opacity group-hover:opacity-100',
                    'text-muted-foreground hover:text-destructive',
                    items.length <= 1 && 'invisible'
                  )}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Item Button */}
      <Button
        type="button"
        variant="outline"
        onClick={addItem}
        className="w-full md:w-auto"
      >
        <Plus className="mr-2 h-4 w-4" />
        Add Line Item
      </Button>
    </div>
  )
}

