import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva('inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50', {
  variants: {
    variant: {
      default: 'bg-teal-600 text-white shadow-sm hover:bg-teal-700',
      outline: 'border border-slate-200 bg-white text-navy-900 hover:bg-slate-50',
      destructive: 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100',
      ghost: 'text-navy-900 hover:bg-slate-100'
    },
    size: { default: 'h-10 px-4 py-2', sm: 'h-8 px-3 text-xs', lg: 'h-12 px-5 text-base' }
  },
  defaultVariants: { variant: 'default', size: 'default' }
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <section className={cn('rounded-2xl border border-slate-200 bg-white shadow-card', className)} {...props} />; }
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('p-5 pb-3 sm:p-6 sm:pb-4', className)} {...props} />; }
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('p-5 pt-2 sm:p-6 sm:pt-2', className)} {...props} />; }
export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) { return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold', className)} {...props} />; }
