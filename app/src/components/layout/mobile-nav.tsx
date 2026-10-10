'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from '@/components/ui/sheet'
import { Sidebar } from './sidebar'
import { Logo } from '@/components/brand/logo'

export function MobileNav() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-16 items-center justify-between border-b bg-card px-4 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon">
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[232px] p-0">
          <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
          <Sidebar onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <Link href="/dashboard">
        <Logo />
      </Link>

      <Button size="icon" asChild>
        <Link href="/invoices/new">
          <Plus className="h-5 w-5" />
          <span className="sr-only">New invoice</span>
        </Link>
      </Button>
    </div>
  )
}
