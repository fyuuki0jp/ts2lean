namespace Ts2Lean

/-- ECMAScript strings are sequences of UTF-16 code units, including lone
    surrogates. No Unicode normalization or scalar-value decoding is performed. -/
structure JSString where
  units : List UInt16
  deriving DecidableEq, Repr

end Ts2Lean
