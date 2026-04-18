"use client";

import { useEffect, useState, useTransition } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarDays, Coins, FileText, Landmark } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { createTransaction } from "@/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  getTransactionFormDefaults,
  type TransactionFormValues,
  type TransactionTypeValue,
  transactionFormSchema,
} from "@/lib/validators/transaction";
import { getTodayDateInputValue } from "@/lib/money";

interface TransactionFormProps {
  teamId: string;
  preferredType: TransactionTypeValue;
  onPreferredTypeChange: (type: TransactionTypeValue) => void;
}

const transactionTypeOptions: Array<{
  value: TransactionTypeValue;
  label: string;
  description: string;
}> = [
  {
    value: "ADD",
    label: "Add money",
    description: "Record new money coming in",
  },
  {
    value: "REMOVE",
    label: "Remove money",
    description: "Track money going out",
  },
];

export function TransactionForm({
  teamId,
  preferredType,
  onPreferredTypeChange,
}: TransactionFormProps) {
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const form = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionFormSchema),
    defaultValues: getTransactionFormDefaults(),
  });

  useEffect(() => {
    form.setValue("type", preferredType, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [form, preferredType]);

  async function submitTransaction(values: TransactionFormValues) {
    setServerMessage(null);

    const result = await createTransaction(teamId, values);

    if (result.status === "error") {
      if (result.fieldErrors) {
        for (const [key, message] of Object.entries(result.fieldErrors)) {
          if (!message) {
            continue;
          }

          form.setError(key as keyof TransactionFormValues, {
            type: "server",
            message,
          });
        }
      }

      setServerMessage(result.message);
      toast.error(result.message);
      return;
    }

    form.reset({
      amount: "",
      note: "",
      type: values.type,
      transactionDate: getTodayDateInputValue(),
    });
    onPreferredTypeChange(values.type);
    toast.success(result.message);
  }

  const selectedType = useWatch({
    control: form.control,
    name: "type",
  });

  return (
    <Card
      id="transaction-form"
      className="glass-panel animate-entry border-white/75 bg-white/82 [animation-delay:180ms]"
    >
      <CardHeader className="space-y-2">
        <CardTitle className="text-xl">Create transaction</CardTitle>
        <CardDescription className="leading-6">
          Save a permanent entry for this team with validated amount, note,
          type, and created date.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 sm:px-6 sm:pb-6">
        <form
          className="space-y-4 sm:space-y-5"
          onSubmit={form.handleSubmit((values) => {
            form.clearErrors();

            startTransition(() => {
              void submitTransaction(values);
            });
          })}
        >
          <div className="space-y-2">
            <Label htmlFor="type">Transaction type</Label>
            <Select
              value={selectedType}
              onValueChange={(value) => {
                form.setValue("type", value as TransactionTypeValue, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
                onPreferredTypeChange(value as TransactionTypeValue);
              }}
            >
              <SelectTrigger id="type">
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {transactionTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.type ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.type.message}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {
                  transactionTypeOptions.find((option) => option.value === selectedType)
                    ?.description
                }
              </p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <div className="relative">
                <Coins className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="amount"
                  placeholder="0.00"
                  inputMode="decimal"
                  autoComplete="off"
                  className="pl-10"
                  {...form.register("amount")}
                />
              </div>
              {form.formState.errors.amount ? (
                <p className="text-sm text-destructive">
                  {form.formState.errors.amount.message}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Use up to two decimal places. Amounts are stored in minor units
                  for precision.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="transactionDate">Created date</Label>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="transactionDate"
                  type="date"
                  max={getTodayDateInputValue()}
                  className="pl-10"
                  {...form.register("transactionDate")}
                />
              </div>
              {form.formState.errors.transactionDate ? (
                <p className="text-sm text-destructive">
                  {form.formState.errors.transactionDate.message}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Future dates are blocked to keep the ledger consistent.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">Note</Label>
            <div className="relative">
              <FileText className="pointer-events-none absolute left-3 top-4 h-4 w-4 text-muted-foreground" />
              <Textarea
                id="note"
                placeholder="What was this transaction for?"
                rows={4}
                className="pl-10"
                {...form.register("note")}
              />
            </div>
            {form.formState.errors.note ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.note.message}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Optional context makes the history easier to scan later.
              </p>
            )}
          </div>

          <div
            className={cn(
              "rounded-2xl border px-4 py-3 text-sm leading-6",
              serverMessage
                ? "border-destructive/20 bg-destructive/5 text-destructive"
                : "border-border/70 bg-muted/50 text-muted-foreground",
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              <Landmark className="h-4 w-4" />
              {serverMessage
                ? "We need your attention"
                : "Immediate dashboard refresh is enabled"}
            </div>
            <p className="mt-1">
              {serverMessage ??
                "After a successful save, the balance card and history list refresh automatically, and the entry is tagged with the acting admin."}
            </p>
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending
              ? "Saving transaction..."
              : selectedType === "REMOVE"
                ? "Save removal"
                : "Save addition"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
