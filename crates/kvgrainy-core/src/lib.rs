//! Fit an image under a size limit with the best quality possible.
//!
//! The engine is UI-agnostic: load with [`load::load_image`], then call
//! [`search::optimize`] with a size limit. Searching can be cancelled and
//! reports progress through callbacks so any front end can drive it.
//!
//! Codecs sit behind the [`Encoder`] trait. [`NativeEncoder`] is the default
//! (feature `native`); [`search::optimize_with`] takes any other implementation.

pub mod encode;
pub mod limit;
pub mod load;
#[cfg(feature = "native")]
pub mod native;
pub mod proxy;
pub mod raster;
pub mod score;
pub mod search;

pub use encode::{Encoder, Format};
pub use limit::parse_size_limit;
#[cfg(feature = "native")]
pub use native::NativeEncoder;
#[cfg(feature = "native")]
pub use search::{best_effort, optimize};
pub use search::{
    best_effort_with, candidate_formats, optimize_with, pick_best, pick_best_of, search_one_format, Candidate, Effort, Error,
    FormatOutcome, Options, Progress, SCALE_FACTORS,
};
