"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ScreenView } from "@/components/ScreenView";
import type { QuizQuestion } from "@/lib/quiz";
import styles from "./quiz.module.css";

type Props = {
  step: number;
  totalSteps: number;
  question: QuizQuestion;
  initialSelectedValue: string | null;
};

export function QuizStepScreen({ step, totalSteps, question, initialSelectedValue }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState(initialSelectedValue);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNavigating, startTransition] = useTransition();

  async function handleSelect(value: string) {
    if (pendingValue) return;
    setSelected(value);
    setPendingValue(value);
    setError(null);

    try {
      const res = await fetch("/api/quiz/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionKey: question.key, answerValue: value }),
      });
      if (!res.ok) throw new Error("save failed");

      startTransition(() => {
        router.push(step >= totalSteps ? "/quiz/complete" : `/quiz/${step + 1}`);
      });
    } catch {
      setPendingValue(null);
      setError("Couldn't save your answer, please try again.");
    }
  }

  const busy = pendingValue !== null || isNavigating;

  return (
    <main className={styles.screen}>
      <ScreenView key={step} screen="quiz" step={String(step)} />
      <div className={styles.inner}>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ "--progress": step / totalSteps } as React.CSSProperties}
          />
        </div>
        <p className={styles.stepLabel}>
          Question {step} of {totalSteps}
        </p>
        <h1 className={styles.prompt}>{question.prompt}</h1>

        <div className={styles.options} role="radiogroup" aria-label={question.prompt}>
          {question.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected === opt.value}
              className={`${styles.option} ${selected === opt.value ? styles.optionSelected : ""}`}
              onClick={() => handleSelect(opt.value)}
              disabled={busy}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {step > 1 && (
          <div className={styles.backRow}>
            <button type="button" className={styles.backLink} onClick={() => router.back()} disabled={busy}>
              <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
              Back
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
