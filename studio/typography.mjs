import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { shapeText, clearShapingCache, getShapingStatus } from './text-shaping.mjs';

// Chrome CoreText calibrated advance & vertical metrics table on macOS (1000px em basis)
export const CALIBRATED_FONT_METRICS = {"PingFang SC":{"400":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.333,0.333,0.427,0.6,0.6,0.97,0.726,0.244,0.333,0.333,0.506,0.605,0.264,0.605,0.264,0.5,0.6,0.401,0.6,0.6,0.6,0.6,0.6,0.547,0.6,0.6,0.264,0.264,0.605,0.605,0.605,0.537,0.858,0.657,0.677,0.728,0.706,0.637,0.577,0.748,0.72,0.237,0.517,0.69,0.588,0.882,0.719,0.767,0.642,0.767,0.676,0.632,0.619,0.714,0.639,0.93,0.637,0.662,0.624,0.333,0.5,0.333,0.518,0.5,0.333,0.559,0.586,0.547,0.586,0.555,0.373,0.591,0.556,0.256,0.267,0.529,0.235,0.855,0.559,0.586,0.586,0.586,0.365,0.505,0.355,0.56,0.482,0.755,0.509,0.496,0.487,0.333,0.195,0.333,0.5],"punct":{"·":0.5,"—":1,"–":0.824,"…":1,"“":0.537,"”":0.537,"‘":0.34,"’":0.34,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6,"€":0.7,"£":0.6,"©":0.802,"®":0.802,"™":0.893,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.5,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.333,0.333,0.488,0.6,0.6,0.996,0.751,0.281,0.333,0.333,0.516,0.605,0.275,0.605,0.275,0.5,0.6,0.41,0.6,0.6,0.6,0.6,0.6,0.553,0.6,0.6,0.275,0.275,0.605,0.605,0.605,0.558,0.866,0.679,0.69,0.732,0.72,0.642,0.582,0.756,0.736,0.257,0.538,0.714,0.592,0.903,0.732,0.775,0.655,0.775,0.697,0.651,0.615,0.734,0.659,0.953,0.664,0.691,0.639,0.333,0.5,0.333,0.545,0.5,0.333,0.572,0.602,0.561,0.602,0.567,0.378,0.602,0.577,0.275,0.276,0.553,0.254,0.884,0.581,0.6,0.602,0.602,0.374,0.525,0.362,0.582,0.506,0.777,0.537,0.526,0.506,0.333,0.214,0.333,0.5],"punct":{"·":0.5,"—":1,"–":0.824,"…":1,"“":0.614,"”":0.614,"‘":0.372,"’":0.372,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6,"€":0.718,"£":0.6,"©":0.802,"®":0.802,"™":0.903,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.5,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.333,0.333,0.488,0.6,0.6,0.996,0.751,0.281,0.333,0.333,0.516,0.605,0.275,0.605,0.275,0.5,0.6,0.41,0.6,0.6,0.6,0.6,0.6,0.553,0.6,0.6,0.275,0.275,0.605,0.605,0.605,0.558,0.866,0.679,0.69,0.732,0.72,0.642,0.582,0.756,0.736,0.257,0.538,0.714,0.592,0.903,0.732,0.775,0.655,0.775,0.697,0.651,0.615,0.734,0.659,0.953,0.664,0.691,0.639,0.333,0.5,0.333,0.545,0.5,0.333,0.572,0.602,0.561,0.602,0.567,0.378,0.602,0.577,0.275,0.276,0.553,0.254,0.884,0.581,0.6,0.602,0.602,0.374,0.525,0.362,0.582,0.506,0.777,0.537,0.526,0.506,0.333,0.214,0.333,0.5],"punct":{"·":0.5,"—":1,"–":0.824,"…":1,"“":0.614,"”":0.614,"‘":0.372,"’":0.372,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6,"€":0.718,"£":0.6,"©":0.802,"®":0.802,"™":0.903,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.5,"◆":1,"◇":1}}},"Songti SC":{"400":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.292,0.292,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.679,0.618,0.635,0.771,0.658,0.566,0.771,0.766,0.354,0.333,0.741,0.576,0.847,0.773,0.78,0.566,0.77,0.636,0.477,0.617,0.71,0.68,0.888,0.7,0.659,0.653,0.271,0.5,0.271,0.5,0.501,0.333,0.504,0.521,0.412,0.514,0.431,0.327,0.469,0.532,0.27,0.224,0.474,0.272,0.785,0.532,0.508,0.525,0.523,0.362,0.364,0.323,0.518,0.47,0.667,0.457,0.422,0.424,0.479,0.5,0.479,0.667],"punct":{"·":1,"—":1,"–":1,"…":1,"“":0.389,"”":0.412,"‘":0.234,"’":0.268,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.692,"€":0.712,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.354,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.292,0.292,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.687,0.629,0.636,0.773,0.664,0.576,0.77,0.791,0.354,0.334,0.745,0.588,0.904,0.781,0.774,0.579,0.765,0.678,0.469,0.625,0.717,0.69,0.901,0.707,0.672,0.643,0.271,0.5,0.271,0.5,0.507,0.333,0.498,0.519,0.408,0.517,0.427,0.343,0.445,0.531,0.27,0.237,0.497,0.271,0.781,0.531,0.495,0.522,0.521,0.37,0.361,0.333,0.524,0.472,0.667,0.454,0.442,0.41,0.479,0.5,0.479,0.667],"punct":{"·":1,"—":1,"–":1,"…":1,"“":0.404,"”":0.408,"‘":0.249,"’":0.263,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.672,"€":0.636,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.354,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.292,0.292,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.687,0.629,0.636,0.773,0.664,0.576,0.77,0.791,0.354,0.334,0.745,0.588,0.904,0.781,0.774,0.579,0.765,0.678,0.469,0.625,0.717,0.69,0.901,0.707,0.672,0.643,0.271,0.5,0.271,0.5,0.507,0.333,0.498,0.519,0.408,0.517,0.427,0.343,0.445,0.531,0.27,0.237,0.497,0.271,0.781,0.531,0.495,0.522,0.521,0.37,0.361,0.333,0.524,0.472,0.667,0.454,0.442,0.41,0.479,0.5,0.479,0.667],"punct":{"·":1,"—":1,"–":1,"…":1,"“":0.404,"”":0.408,"‘":0.249,"’":0.263,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.672,"€":0.636,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.354,"◆":1,"◇":1}}},"Heiti SC":{"400":{"cjk":1,"emoji":1,"ascent":0.86,"descent":0.14,"ascii":[0.25,0.295,0.309,0.72,0.534,0.775,0.757,0.198,0.369,0.369,0.425,0.606,0.277,0.332,0.277,0.437,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.277,0.277,0.606,0.606,0.606,0.495,0.867,0.74,0.574,0.813,0.744,0.536,0.485,0.872,0.683,0.226,0.482,0.591,0.462,0.919,0.74,0.869,0.592,0.871,0.607,0.498,0.426,0.655,0.702,0.96,0.609,0.592,0.48,0.351,0.605,0.351,0.672,0.5,0.378,0.683,0.682,0.647,0.685,0.65,0.314,0.673,0.61,0.2,0.203,0.502,0.2,0.938,0.61,0.655,0.682,0.682,0.301,0.388,0.339,0.608,0.554,0.831,0.48,0.536,0.425,0.351,0.477,0.351,0.606],"punct":{"·":1,"—":1,"–":0.5,"…":1,"“":1,"”":1,"‘":1,"’":1,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.554,"€":0.851,"£":0.554,"©":0.831,"®":0.824,"™":1,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.606,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":0.86,"descent":0.14,"ascii":[0.25,0.295,0.309,0.72,0.554,0.775,0.757,0.198,0.369,0.369,0.425,0.606,0.277,0.332,0.277,0.437,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.277,0.277,0.606,0.606,0.606,0.495,0.867,0.74,0.574,0.813,0.744,0.536,0.485,0.872,0.683,0.226,0.482,0.591,0.462,0.919,0.74,0.869,0.592,0.871,0.607,0.498,0.426,0.655,0.702,0.96,0.609,0.592,0.48,0.351,0.605,0.351,0.672,0.5,0.378,0.683,0.682,0.647,0.685,0.65,0.314,0.673,0.61,0.2,0.203,0.502,0.2,0.938,0.61,0.655,0.682,0.682,0.301,0.388,0.339,0.608,0.554,0.831,0.48,0.536,0.425,0.351,0.672,0.351,0.606],"punct":{"·":1,"—":1,"–":0.5,"…":1,"“":1,"”":1,"‘":1,"’":1,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.554,"€":0.847,"£":0.554,"©":0.767,"®":0.767,"™":0.789,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.606,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":0.86,"descent":0.14,"ascii":[0.25,0.295,0.309,0.72,0.554,0.775,0.757,0.198,0.369,0.369,0.425,0.606,0.277,0.332,0.277,0.437,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.554,0.277,0.277,0.606,0.606,0.606,0.495,0.867,0.74,0.574,0.813,0.744,0.536,0.485,0.872,0.683,0.226,0.482,0.591,0.462,0.919,0.74,0.869,0.592,0.871,0.607,0.498,0.426,0.655,0.702,0.96,0.609,0.592,0.48,0.351,0.605,0.351,0.672,0.5,0.378,0.683,0.682,0.647,0.685,0.65,0.314,0.673,0.61,0.2,0.203,0.502,0.2,0.938,0.61,0.655,0.682,0.682,0.301,0.388,0.339,0.608,0.554,0.831,0.48,0.536,0.425,0.351,0.672,0.351,0.606],"punct":{"·":1,"—":1,"–":0.5,"…":1,"“":1,"”":1,"‘":1,"’":1,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.554,"€":0.847,"£":0.554,"©":0.767,"®":0.767,"™":0.789,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.606,"◆":1,"◇":1}}},"Kaiti SC":{"400":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.339,0.329,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.699,0.642,0.644,0.773,0.662,0.572,0.771,0.807,0.354,0.333,0.743,0.588,0.93,0.777,0.776,0.573,0.767,0.695,0.484,0.615,0.714,0.686,0.895,0.704,0.672,0.66,0.321,0.5,0.323,0.5,0.505,0.333,0.511,0.52,0.422,0.515,0.429,0.337,0.48,0.532,0.278,0.232,0.519,0.271,0.783,0.531,0.511,0.523,0.521,0.388,0.384,0.355,0.529,0.471,0.667,0.476,0.459,0.432,0.479,0.5,0.479,0.667],"punct":{"·":0.291,"—":1,"–":1,"…":1,"“":0.404,"”":0.404,"‘":0.248,"’":0.249,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.676,"€":0.71,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.354,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.32,0.321,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.699,0.642,0.644,0.773,0.662,0.572,0.771,0.807,0.354,0.333,0.743,0.588,0.93,0.777,0.776,0.573,0.767,0.695,0.484,0.615,0.714,0.686,0.895,0.704,0.672,0.66,0.327,0.5,0.329,0.5,0.505,0.333,0.511,0.52,0.422,0.515,0.429,0.337,0.48,0.532,0.278,0.232,0.519,0.271,0.783,0.531,0.511,0.523,0.521,0.388,0.384,0.355,0.529,0.471,0.667,0.476,0.459,0.432,0.479,0.5,0.479,0.667],"punct":{"·":0.291,"—":1,"–":1,"…":1,"“":0.404,"”":0.404,"‘":0.248,"’":0.249,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.676,"€":0.71,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":1,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":1.06,"descent":0.34,"ascii":[0.25,0.219,0.406,0.667,0.448,0.823,0.729,0.177,0.32,0.321,0.427,0.667,0.219,0.313,0.219,0.5,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.469,0.219,0.219,0.667,0.667,0.667,0.365,0.917,0.699,0.642,0.644,0.773,0.662,0.572,0.771,0.807,0.354,0.333,0.743,0.588,0.93,0.777,0.776,0.573,0.767,0.695,0.484,0.615,0.714,0.686,0.895,0.704,0.672,0.66,0.327,0.5,0.329,0.5,0.505,0.333,0.511,0.52,0.422,0.515,0.429,0.337,0.48,0.532,0.278,0.232,0.519,0.271,0.783,0.531,0.511,0.523,0.521,0.388,0.384,0.355,0.529,0.471,0.667,0.476,0.459,0.432,0.479,0.5,0.479,0.667],"punct":{"·":0.291,"—":1,"–":1,"…":1,"“":0.404,"”":0.404,"‘":0.248,"’":0.249,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.676,"€":0.71,"£":0.573,"©":0.76,"®":0.76,"™":0.979,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":1,"◆":1,"◇":1}}},"Helvetica Neue":{"400":{"cjk":1,"emoji":1,"ascent":0.952,"descent":0.213,"ascii":[0.278,0.259,0.426,0.556,0.556,1,0.63,0.278,0.259,0.259,0.352,0.6,0.278,0.389,0.278,0.333,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.278,0.278,0.6,0.6,0.6,0.556,0.8,0.648,0.685,0.722,0.704,0.611,0.574,0.759,0.722,0.259,0.519,0.667,0.556,0.871,0.722,0.76,0.648,0.76,0.685,0.648,0.574,0.722,0.611,0.926,0.611,0.648,0.611,0.259,0.333,0.259,0.6,0.5,0.222,0.537,0.593,0.537,0.593,0.537,0.296,0.574,0.556,0.222,0.222,0.519,0.222,0.853,0.556,0.574,0.593,0.593,0.333,0.5,0.315,0.556,0.5,0.758,0.518,0.5,0.48,0.333,0.222,0.333,0.6],"punct":{"·":0.278,"—":1,"–":0.5,"…":1,"“":0.426,"”":0.426,"‘":0.278,"’":0.278,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.556,"€":0.556,"£":0.556,"©":0.8,"®":0.8,"™":0.99,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.35,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":0.975,"descent":0.217,"ascii":[0.278,0.278,0.463,0.556,0.556,1,0.685,0.278,0.296,0.296,0.407,0.6,0.278,0.407,0.278,0.371,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.278,0.278,0.6,0.6,0.6,0.556,0.8,0.685,0.704,0.741,0.741,0.648,0.593,0.759,0.741,0.295,0.556,0.722,0.593,0.907,0.741,0.778,0.667,0.778,0.722,0.649,0.611,0.741,0.63,0.944,0.667,0.667,0.648,0.333,0.371,0.333,0.6,0.5,0.259,0.574,0.611,0.574,0.611,0.574,0.333,0.611,0.593,0.258,0.278,0.574,0.258,0.906,0.593,0.611,0.611,0.611,0.389,0.537,0.352,0.593,0.52,0.814,0.537,0.519,0.519,0.333,0.223,0.333,0.6],"punct":{"·":0.278,"—":1,"–":0.5,"…":1,"“":0.463,"”":0.463,"‘":0.278,"’":0.278,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.556,"€":0.556,"£":0.556,"©":0.8,"®":0.8,"™":1,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.35,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":0.975,"descent":0.217,"ascii":[0.278,0.278,0.463,0.556,0.556,1,0.685,0.278,0.296,0.296,0.407,0.6,0.278,0.407,0.278,0.371,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.556,0.278,0.278,0.6,0.6,0.6,0.556,0.8,0.685,0.704,0.741,0.741,0.648,0.593,0.759,0.741,0.295,0.556,0.722,0.593,0.907,0.741,0.778,0.667,0.778,0.722,0.649,0.611,0.741,0.63,0.944,0.667,0.667,0.648,0.333,0.371,0.333,0.6,0.5,0.259,0.574,0.611,0.574,0.611,0.574,0.333,0.611,0.593,0.258,0.278,0.574,0.258,0.906,0.593,0.611,0.611,0.611,0.389,0.537,0.352,0.593,0.52,0.814,0.537,0.519,0.519,0.333,0.223,0.333,0.6],"punct":{"·":0.278,"—":1,"–":0.5,"…":1,"“":0.463,"”":0.463,"‘":0.278,"’":0.278,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.556,"€":0.556,"£":0.556,"©":0.8,"®":0.8,"™":1,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.35,"◆":1,"◇":1}}},"Arial":{"400":{"cjk":1,"emoji":1,"ascent":0.905,"descent":0.212,"ascii":[0.2778,0.2778,0.355,0.5562,0.5562,0.8892,0.667,0.1909,0.333,0.333,0.3892,0.584,0.2778,0.333,0.2778,0.2778,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.2778,0.2778,0.584,0.584,0.584,0.5562,1.0151,0.667,0.667,0.7222,0.7222,0.667,0.6108,0.7778,0.7222,0.2778,0.5,0.667,0.5562,0.833,0.7222,0.7778,0.667,0.7778,0.7222,0.667,0.6108,0.7222,0.667,0.9438,0.667,0.667,0.6108,0.2778,0.2778,0.2778,0.4692,0.5562,0.333,0.5562,0.5562,0.5,0.5562,0.5562,0.2778,0.5562,0.5562,0.2222,0.2222,0.5,0.2222,0.833,0.5562,0.5562,0.5562,0.5562,0.333,0.5,0.2778,0.5562,0.5,0.7222,0.5,0.5,0.5,0.334,0.2598,0.334,0.584],"punct":{"·":0.333,"—":1,"–":0.5562,"…":1,"“":0.333,"”":0.333,"‘":0.2222,"’":0.2222,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.5562,"€":0.5562,"£":0.5562,"©":0.7368,"®":0.7368,"™":1,"→":1,"←":1,"↑":0.5,"↓":0.5,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.3501,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":0.905,"descent":0.212,"ascii":[0.2778,0.333,0.4741,0.5562,0.5562,0.8892,0.7222,0.2378,0.333,0.333,0.3892,0.584,0.2778,0.333,0.2778,0.2778,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.333,0.333,0.584,0.584,0.584,0.6108,0.9751,0.7222,0.7222,0.7222,0.7222,0.667,0.6108,0.7778,0.7222,0.2778,0.5562,0.7222,0.6108,0.833,0.7222,0.7778,0.667,0.7778,0.7222,0.667,0.6108,0.7222,0.667,0.9438,0.667,0.667,0.6108,0.333,0.2778,0.333,0.584,0.5562,0.333,0.5562,0.6108,0.5562,0.6108,0.5562,0.333,0.6108,0.6108,0.2778,0.2778,0.5562,0.2778,0.8892,0.6108,0.6108,0.6108,0.6108,0.3892,0.5562,0.333,0.6108,0.5562,0.7778,0.5562,0.5562,0.5,0.3892,0.2798,0.3892,0.584],"punct":{"·":0.333,"—":1,"–":0.5562,"…":1,"“":0.5,"”":0.5,"‘":0.2778,"’":0.2778,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.5562,"€":0.5562,"£":0.5562,"©":0.7368,"®":0.7368,"™":1,"→":1,"←":1,"↑":0.5,"↓":0.5,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.3501,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":0.905,"descent":0.212,"ascii":[0.2778,0.333,0.4741,0.5562,0.5562,0.8892,0.7222,0.2378,0.333,0.333,0.3892,0.584,0.2778,0.333,0.2778,0.2778,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.5562,0.333,0.333,0.584,0.584,0.584,0.6108,0.9751,0.7222,0.7222,0.7222,0.7222,0.667,0.6108,0.7778,0.7222,0.2778,0.5562,0.7222,0.6108,0.833,0.7222,0.7778,0.667,0.7778,0.7222,0.667,0.6108,0.7222,0.667,0.9438,0.667,0.667,0.6108,0.333,0.2778,0.333,0.584,0.5562,0.333,0.5562,0.6108,0.5562,0.6108,0.5562,0.333,0.6108,0.6108,0.2778,0.2778,0.5562,0.2778,0.8892,0.6108,0.6108,0.6108,0.6108,0.3892,0.5562,0.333,0.6108,0.5562,0.7778,0.5562,0.5562,0.5,0.3892,0.2798,0.3892,0.584],"punct":{"·":0.333,"—":1,"–":0.5562,"…":1,"“":0.5,"”":0.5,"‘":0.2778,"’":0.2778,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.5562,"€":0.5562,"£":0.5562,"©":0.7368,"®":0.7368,"™":1,"→":1,"←":1,"↑":0.5,"↓":0.5,"✓":0.7642,"✗":0.5708,"★":1,"☆":1,"•":0.3501,"◆":1,"◇":1}}},"Georgia":{"400":{"cjk":1,"emoji":1,"ascent":0.917,"descent":0.219,"ascii":[0.2412,0.3311,0.4116,0.6431,0.6099,0.8174,0.7104,0.2153,0.375,0.375,0.4722,0.6431,0.2695,0.374,0.2695,0.4688,0.6138,0.4297,0.5586,0.5518,0.5649,0.5283,0.5659,0.5024,0.5962,0.5659,0.3125,0.3125,0.6431,0.6431,0.6431,0.4785,0.9287,0.6709,0.6538,0.6421,0.749,0.6533,0.5991,0.7251,0.8149,0.3896,0.5176,0.6943,0.6035,0.9272,0.7671,0.7441,0.6099,0.7441,0.7017,0.561,0.6187,0.7563,0.6665,0.9756,0.7104,0.6152,0.6016,0.375,0.4688,0.375,0.6431,0.6431,0.5,0.5039,0.5601,0.4541,0.5742,0.4834,0.3252,0.5093,0.582,0.293,0.292,0.5356,0.2861,0.8809,0.5908,0.5391,0.5713,0.5596,0.4097,0.4321,0.3452,0.5752,0.4966,0.7373,0.5049,0.4922,0.4438,0.4302,0.375,0.4302,0.6431],"punct":{"·":0.2793,"—":0.8569,"–":0.6431,"…":0.8071,"“":0.4102,"”":0.4102,"‘":0.2266,"’":0.2266,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6147,"€":0.6421,"£":0.6221,"©":0.9419,"®":0.9419,"™":0.9424,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.3926,"◆":1,"◇":1}},"600":{"cjk":1,"emoji":1,"ascent":0.917,"descent":0.219,"ascii":[0.2539,0.3765,0.5098,0.7031,0.6406,0.8794,0.7993,0.269,0.4468,0.4468,0.4819,0.7031,0.3281,0.3789,0.3281,0.4717,0.7012,0.4897,0.6265,0.6245,0.6494,0.5991,0.6479,0.5542,0.6763,0.6479,0.3672,0.3672,0.7031,0.7031,0.7031,0.5483,0.9668,0.7583,0.7573,0.7153,0.834,0.7212,0.6714,0.8071,0.9131,0.4458,0.5952,0.8169,0.6855,1.0234,0.8394,0.8198,0.7012,0.8198,0.7974,0.6489,0.6841,0.8335,0.7622,1.1265,0.8086,0.7319,0.6895,0.4468,0.4717,0.4468,0.7031,0.7031,0.5,0.5957,0.6455,0.5313,0.6631,0.5718,0.3931,0.5767,0.6797,0.3535,0.3462,0.6318,0.3442,1.0156,0.6899,0.6357,0.6577,0.6484,0.52,0.5127,0.3975,0.6768,0.5669,0.8633,0.5879,0.562,0.5254,0.5,0.3877,0.5,0.7031],"punct":{"·":0.3379,"—":0.9277,"–":0.7031,"…":0.9419,"“":0.519,"”":0.519,"‘":0.2686,"’":0.2686,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.7324,"€":0.7153,"£":0.6899,"©":0.9419,"®":0.9419,"™":0.9473,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.4375,"◆":1,"◇":1}},"700":{"cjk":1,"emoji":1,"ascent":0.917,"descent":0.219,"ascii":[0.2539,0.3765,0.5098,0.7031,0.6406,0.8794,0.7993,0.269,0.4468,0.4468,0.4819,0.7031,0.3281,0.3789,0.3281,0.4717,0.7012,0.4897,0.6265,0.6245,0.6494,0.5991,0.6479,0.5542,0.6763,0.6479,0.3672,0.3672,0.7031,0.7031,0.7031,0.5483,0.9668,0.7583,0.7573,0.7153,0.834,0.7212,0.6714,0.8071,0.9131,0.4458,0.5952,0.8169,0.6855,1.0234,0.8394,0.8198,0.7012,0.8198,0.7974,0.6489,0.6841,0.8335,0.7622,1.1265,0.8086,0.7319,0.6895,0.4468,0.4717,0.4468,0.7031,0.7031,0.5,0.5957,0.6455,0.5313,0.6631,0.5718,0.3931,0.5767,0.6797,0.3535,0.3462,0.6318,0.3442,1.0156,0.6899,0.6357,0.6577,0.6484,0.52,0.5127,0.3975,0.6768,0.5669,0.8633,0.5879,0.562,0.5254,0.5,0.3877,0.5,0.7031],"punct":{"·":0.3379,"—":0.9277,"–":0.7031,"…":0.9419,"“":0.519,"”":0.519,"‘":0.2686,"’":0.2686,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.7324,"€":0.7153,"£":0.6899,"©":0.9419,"®":0.9419,"™":0.9473,"→":1,"←":1,"↑":1,"↓":1,"✓":0.7549,"✗":0.5708,"★":1,"☆":1,"•":0.4375,"◆":1,"◇":1}}},"Menlo":{"400":{"cjk":1,"emoji":1,"ascent":0.928,"descent":0.236,"ascii":[0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021],"punct":{"·":0.6021,"—":0.6021,"–":0.6021,"…":0.6021,"“":0.6021,"”":0.6021,"‘":0.6021,"’":0.6021,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6021,"€":0.6021,"£":0.6021,"©":0.6021,"®":0.6021,"™":0.6021,"→":0.6021,"←":0.6021,"↑":0.6021,"↓":0.6021,"✓":0.6021,"✗":0.6021,"★":0.6021,"☆":0.6021,"•":0.6021,"◆":0.6021,"◇":0.6021}},"600":{"cjk":1,"emoji":1,"ascent":0.928,"descent":0.236,"ascii":[0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021],"punct":{"·":0.6021,"—":0.6021,"–":0.6021,"…":0.6021,"“":0.6021,"”":0.6021,"‘":0.6021,"’":0.6021,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6021,"€":0.6021,"£":0.6021,"©":0.6021,"®":0.6021,"™":0.6021,"→":0.6021,"←":0.6021,"↑":0.6021,"↓":0.6021,"✓":0.6021,"✗":0.6021,"★":0.6021,"☆":0.6021,"•":0.6021,"◆":0.6021,"◇":0.6021}},"700":{"cjk":1,"emoji":1,"ascent":0.928,"descent":0.236,"ascii":[0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021,0.6021],"punct":{"·":0.6021,"—":0.6021,"–":0.6021,"…":0.6021,"“":0.6021,"”":0.6021,"‘":0.6021,"’":0.6021,"（":1,"）":1,"，":1,"。":1,"：":1,"；":1,"！":1,"？":1,"、":1,"《":1,"》":1,"【":1,"】":1,"「":1,"」":1,"¥":0.6021,"€":0.6021,"£":0.6021,"©":0.6021,"®":0.6021,"™":0.6021,"→":0.6021,"←":0.6021,"↑":0.6021,"↓":0.6021,"✓":0.6021,"✗":0.6021,"★":0.6021,"☆":0.6021,"•":0.6021,"◆":0.6021,"◇":0.6021}}}};

export const SYSTEM_FONT_FILES = {
  "PingFang SC": "/System/Library/Fonts/PingFang.ttc",
  "Songti SC": "/System/Library/Fonts/Supplemental/Songti.ttc",
  "Heiti SC": "/System/Library/Fonts/STHeiti Light.ttc",
  "Kaiti SC": "/System/Library/Fonts/Supplemental/Kaiti.ttc",
  "Helvetica Neue": "/System/Library/Fonts/HelveticaNeue.ttc",
  "Arial": "/System/Library/Fonts/Supplemental/Arial.ttf",
  "Georgia": "/System/Library/Fonts/Supplemental/Georgia.ttf",
  "Menlo": "/System/Library/Fonts/Menlo.ttc",
};

export const FONT_ALIASES = {
  "pingfang sc": "PingFang SC",
  "pingfang": "PingFang SC",
  "苹方": "PingFang SC",
  "苹方-简": "PingFang SC",
  "songti sc": "Songti SC",
  "stsong": "Songti SC",
  "宋体": "Songti SC",
  "华文宋体": "Songti SC",
  "heiti sc": "Heiti SC",
  "stheiti": "Heiti SC",
  "黑体": "Heiti SC",
  "kaiti sc": "Kaiti SC",
  "stkaiti": "Kaiti SC",
  "楷体": "Kaiti SC",
  "helvetica neue": "Helvetica Neue",
  "helvetica": "Helvetica Neue",
  "sf pro text": "Helvetica Neue",
  "sf pro display": "Helvetica Neue",
  "inter": "Helvetica Neue",
  "arial": "Arial",
  "georgia": "Georgia",
  "times new roman": "Georgia",
  "menlo": "Menlo",
  "sf mono": "Menlo",
  "monaco": "Menlo",
  "monospace": "Menlo",
};

const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

let fontResourceVersion = 1;
const fontLoadingStates = new Map();
const customRegisteredFonts = new Map();
const browserMeasuredOverrides = new Map();
const typographyCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;
let cacheInvalidations = 0;

export function getFontResourceVersion() {
  return fontResourceVersion;
}

export function bumpFontResourceVersion() {
  fontResourceVersion++;
  cacheInvalidations++;
  typographyCache.clear();
  clearShapingCache();
  return fontResourceVersion;
}

export function setFontLoadingState(fontFamily, state = "loaded") {
  const prev = fontLoadingStates.get(fontFamily);
  fontLoadingStates.set(fontFamily, state);
  if (prev !== state) {
    bumpFontResourceVersion();
  }
  return { fontFamily, state, fontResourceVersion };
}

export function registerProjectFont(fontFamily, { fontFile = null, baseMetricsFont = "PingFang SC", state = "loaded" } = {}) {
  customRegisteredFonts.set(fontFamily.toLowerCase(), {
    fontFamily,
    fontFile,
    baseMetricsFont,
  });
  fontLoadingStates.set(fontFamily, state);
  bumpFontResourceVersion();
}

export function registerBrowserTextMeasurement(cacheKey, rect) {
  browserMeasuredOverrides.set(cacheKey, rect);
}

export function getTypographyCacheStats() {
  return {
    size: typographyCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    invalidations: cacheInvalidations,
    fontResourceVersion,
  };
}

export function clearTypographyCache() {
  typographyCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
  cacheInvalidations++;
}

export function resolveFontDescriptor(requestedFont, { defaultFontFamily = "PingFang SC", projectDir = null } = {}) {
  const raw = String(requestedFont || defaultFontFamily || "PingFang SC").trim();
  const primary = raw.split(",")[0].replace(/[\x27"]/g, "").trim();
  const lower = primary.toLowerCase();

  const loadState = fontLoadingStates.get(primary) || fontLoadingStates.get(lower) || "loaded";
  if (loadState === "loading") {
    const fallback = FONT_ALIASES[String(defaultFontFamily).toLowerCase()] || "PingFang SC";
    return {
      requestedFont: primary,
      resolvedFont: fallback,
      metricsFont: fallback,
      fontStackCss: `"${fallback}", "PingFang SC", sans-serif`,
      status: "delayed-loading",
      isFallback: true,
      fallbackTo: fallback,
      measurementMode: "degraded-estimate",
      fontFile: SYSTEM_FONT_FILES[fallback] || null,
      reason: `字体 "${primary}" 正在加载中，暂时使用回退字体 "${fallback}" 度量，加载完成后将触发重排`,
    };
  }

  if (customRegisteredFonts.has(lower)) {
    const entry = customRegisteredFonts.get(lower);
    const actual = shapeText('M', { family: entry.fontFamily, size: 14, file: entry.fontFile });
    if (!actual || actual.fileValid === false || actual.resolvedFamily.toLowerCase() !== entry.fontFamily.toLowerCase()) {
      const fallback = FONT_ALIASES[String(defaultFontFamily).toLowerCase()] || 'PingFang SC';
      return { requestedFont: primary, resolvedFont: fallback, metricsFont: fallback,
        fontStackCss: `"${fallback}", sans-serif`, status: 'fallback', isFallback: true, fallbackTo: fallback,
        measurementMode: 'degraded-estimate', fontFile: SYSTEM_FONT_FILES[fallback] || null,
        reason: `工程字体 "${primary}" 未能解析到同名字体（系统实际解析为 ${actual?.resolvedFamily || '不可用'}），已回退至 ${fallback}` };
    }
    return {
      requestedFont: primary,
      resolvedFont: entry.fontFamily,
      metricsFont: CALIBRATED_FONT_METRICS[entry.baseMetricsFont] ? entry.baseMetricsFont : "PingFang SC",
      fontStackCss: `"${entry.fontFamily}", "${entry.baseMetricsFont}", "PingFang SC", sans-serif`,
      status: "loaded",
      isFallback: false,
      fallbackTo: null,
      measurementMode: "calibrated-glyph",
      fontFile: entry.fontFile,
      reason: null,
    };
  }

  if (projectDir) {
    for (const ext of [".ttf", ".otf", ".ttc", ".woff2", ".woff"]) {
      const candidate = join(projectDir, "fonts", `${primary}${ext}`);
      if (existsSync(candidate)) {
        const actual = shapeText('M', { family: primary, size: 14, file: candidate });
        if (!actual || actual.fileValid === false || actual.resolvedFamily.toLowerCase() !== lower) {
          const fallback = FONT_ALIASES[String(defaultFontFamily).toLowerCase()] || 'PingFang SC';
          return { requestedFont: primary, resolvedFont: fallback, metricsFont: fallback,
            fontStackCss: `"${fallback}", sans-serif`, status: 'fallback', isFallback: true, fallbackTo: fallback,
            measurementMode: 'degraded-estimate', fontFile: SYSTEM_FONT_FILES[fallback] || null,
            reason: `工程字体文件无效、不可加载或字体族不匹配：${candidate}` };
        }
        return {
          requestedFont: primary,
          resolvedFont: primary,
          metricsFont: CALIBRATED_FONT_METRICS[primary] ? primary : "PingFang SC",
          fontStackCss: `"${primary}", "PingFang SC", sans-serif`,
          status: "loaded",
          isFallback: false,
          fallbackTo: null,
          measurementMode: CALIBRATED_FONT_METRICS[primary] ? "calibrated-glyph" : "degraded-estimate",
          fontFile: candidate,
          reason: null,
        };
      }
    }
  }

  const canonical = FONT_ALIASES[lower] || (CALIBRATED_FONT_METRICS[primary] ? primary : null);
  if (canonical && CALIBRATED_FONT_METRICS[canonical]) {
    const fontFile = SYSTEM_FONT_FILES[canonical] || null;
    return {
      requestedFont: primary,
      resolvedFont: canonical,
      metricsFont: canonical,
      fontStackCss: canonical === "PingFang SC"
        ? `"PingFang SC", sans-serif`
        : `"${canonical}", "PingFang SC", sans-serif`,
      status: "loaded",
      isFallback: false,
      fallbackTo: null,
      measurementMode: "calibrated-glyph",
      fontFile,
      reason: null,
    };
  }

  const fallback = FONT_ALIASES[String(defaultFontFamily || "PingFang SC").toLowerCase()] || "PingFang SC";
  return {
    requestedFont: primary,
    resolvedFont: fallback,
    metricsFont: fallback,
    fontStackCss: `"${fallback}", "PingFang SC", sans-serif`,
    status: "fallback",
    isFallback: true,
    fallbackTo: fallback,
    measurementMode: "calibrated-glyph",
    fontFile: SYSTEM_FONT_FILES[fallback] || null,
    reason: `字体 "${primary}" 未在本机或工程字体目录中找到，已回退至 "${fallback}"`,
  };
}

function getFontMetricsEntry(metricsFont, fontWeight = 400) {
  const fTable = CALIBRATED_FONT_METRICS[metricsFont] || CALIBRATED_FONT_METRICS["PingFang SC"];
  const wKey = Number(fontWeight) >= 700 ? "700" : Number(fontWeight) >= 600 ? "600" : "400";
  return fTable[wKey] || fTable["400"];
}

function isEmojiSegment(seg) {
  const code = seg.codePointAt(0) || 0;
  if (code >= 0x1f000) return true;
  if (/\p{Emoji_Presentation}/u.test(seg)) return true;
  return /\p{Extended_Pictographic}/u.test(seg) && seg.length > 1;
}

function isCjkChar(seg) {
  const code = seg.codePointAt(0) || 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

const CHWS_CLOSING = new Set(["》", "）", "”", "’", "】", "」"]);
const CHWS_FOLLOWING = new Set(["：", "；", "，", "。", "、", "》", "）", "”", "’", "】", "」"]);

export function measureGraphemeAdvance(seg, metricsEntry, fontSize = 14) {
  const code = seg.codePointAt(0) || 0;
  if (code >= 32 && code <= 126) {
    return metricsEntry.ascii[code - 32] * fontSize;
  }
  if (metricsEntry.punct[seg] !== undefined) {
    return metricsEntry.punct[seg] * fontSize;
  }
  if (seg === "°") {
    return (metricsEntry.ascii[0] > 0.55 ? metricsEntry.ascii[0] : 0.3305) * fontSize;
  }
  if (isEmojiSegment(seg)) {
    return Math.round(fontSize * 1.25);
  }
  if (isCjkChar(seg)) {
    return metricsEntry.cjk * fontSize;
  }
  return 0.6 * fontSize;
}

export function measureLineWidthExact(line, {
  fontFamily = "PingFang SC",
  fontSize = 14,
  fontWeight = 400,
  letterSpacing = 0,
  defaultFontFamily = "PingFang SC",
  projectDir = null,
  italic = false,
} = {}) {
  const str = String(line ?? "");
  if (!str.length) return 0;
  const desc = resolveFontDescriptor(fontFamily, { defaultFontFamily, projectDir });
  const shaped = shapeText(str, { family: desc.resolvedFont, size: fontSize, weight: fontWeight, italic, file: desc.fontFile });
  if (shaped) {
    const segments = [...graphemeSegmenter.segment(str)].map(s => s.segment);
    let width = shaped.width;
    // Chromium's inline emoji fallback occupies one CSS em; CoreText's UI
    // fallback includes extra advance. CJK chws is also enabled by Chromium.
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (isEmojiSegment(segment)) {
        const emoji = shapeText(segment, { family: desc.resolvedFont, size: fontSize, weight: fontWeight, italic, file: desc.fontFile });
        if (emoji) width += fontSize - emoji.width;
      }
      if (['PingFang SC', 'Heiti SC'].includes(desc.resolvedFont) && CHWS_CLOSING.has(segments[index - 1]) && CHWS_FOLLOWING.has(segment)) width -= .5 * fontSize;
    }
    return width + segments.length * Number(letterSpacing || 0);
  }
  const m = getFontMetricsEntry(desc.metricsFont, fontWeight);
  const hasChws = desc.metricsFont === "PingFang SC" || desc.metricsFont === "Heiti SC";
  let total = 0;
  let count = 0;
  let prevSeg = "";
  for (const { segment } of graphemeSegmenter.segment(str)) {
    count++;
    let adv = measureGraphemeAdvance(segment, m, fontSize);
    if (hasChws && CHWS_CLOSING.has(prevSeg) && CHWS_FOLLOWING.has(segment)) {
      adv -= 0.5 * fontSize;
    }
    total += adv;
    prevSeg = segment;
  }
  if (letterSpacing && count > 0) {
    total += count * Number(letterSpacing);
  }
  return Number(total.toFixed(2));
}

const CLOSING_PUNCT = new Set(["，", "。", "：", "；", "！", "？", "、", "）", "》", "”", "’", "】", "」"]);

function tokenizeParagraphForWrap(para) {
  const segments = [];
  for (const { segment } of graphemeSegmenter.segment(para)) {
    segments.push(segment);
  }
  const tokens = [];
  let i = 0;
  while (i < segments.length) {
    const s = segments[i];
    if (s === " ") {
      tokens.push({ text: s, kind: "space" });
      i++;
      continue;
    }
    const code = s.codePointAt(0) || 0;
    const isAsciiWordChar = code > 32 && code <= 126;
    if (isAsciiWordChar) {
      let word = s;
      i++;
      while (i < segments.length) {
        const next = segments[i];
        const nc = next.codePointAt(0) || 0;
        if (nc > 32 && nc <= 126) {
          word += next;
          i++;
          if (next === "-") break;
        } else {
          break;
        }
      }
      tokens.push({ text: word, kind: "word" });
      continue;
    }
    let unit = s;
    i++;
    if (i < segments.length && CLOSING_PUNCT.has(segments[i]) && unit.length === 1) {
      unit += segments[i];
      i++;
    }
    tokens.push({ text: unit, kind: "cjk" });
  }
  return tokens;
}

export function wrapTextLinesExact(text, maxWidth, {
  fontFamily = "PingFang SC",
  fontSize = 14,
  fontWeight = 400,
  letterSpacing = 0,
  defaultFontFamily = "PingFang SC",
  projectDir = null,
} = {}) {
  const raw = String(text ?? "");
  if (!raw) return [""];
  const limit = Math.max(fontSize, Number(maxWidth) || 9999);
  const opts = { fontFamily, fontSize, fontWeight, letterSpacing, defaultFontFamily, projectDir };
  const paragraphs = raw.split("\n");
  const lines = [];

  for (const para of paragraphs) {
    if (!para) {
      lines.push("");
      continue;
    }
    if (measureLineWidthExact(para, opts) <= limit + 0.5) {
      lines.push(para);
      continue;
    }
    const tokens = tokenizeParagraphForWrap(para);
    let currentLine = "";

    const breakLongTokenCharByChar = tokenStr => {
      for (const { segment: ch } of graphemeSegmenter.segment(tokenStr)) {
        const cand = currentLine + ch;
        if (currentLine && measureLineWidthExact(cand, opts) > limit + 0.5) {
          lines.push(currentLine);
          currentLine = ch;
        } else {
          currentLine = cand;
        }
      }
    };

    for (const tok of tokens) {
      const cand = currentLine + tok.text;
      if (!currentLine) {
        if (measureLineWidthExact(tok.text, opts) <= limit + 0.5) {
          currentLine = tok.text;
        } else {
          breakLongTokenCharByChar(tok.text);
        }
      } else if (measureLineWidthExact(cand, opts) <= limit + 0.5) {
        currentLine = cand;
      } else {
        lines.push(currentLine.replace(/\s+$/, ""));
        if (tok.kind === "space") {
          currentLine = "";
        } else if (measureLineWidthExact(tok.text, opts) <= limit + 0.5) {
          currentLine = tok.text;
        } else {
          currentLine = "";
          breakLongTokenCharByChar(tok.text);
        }
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }
  return lines.length ? lines : [""];
}

export function buildTypographyCacheKey({
  resolvedFont,
  fontWeight,
  fontStyle,
  fontSize,
  letterSpacing,
  lineHeight,
  text,
  spansSig,
  targetContentW,
  wrapEnabled,
  hasBox,
  bounds,
}) {
  const payload = `${resolvedFont}|${fontWeight}|${fontStyle}|${fontSize}|${letterSpacing}|${lineHeight}|${targetContentW ?? "auto"}|${wrapEnabled ? 1 : 0}|${hasBox ? 1 : 0}|${JSON.stringify(bounds)}|v${fontResourceVersion}|${spansSig || ""}|${text}`;
  return createHash("sha1").update(payload).digest("hex");
}

export function measureTextBoxExact(node, availableW = null, {
  defaultFontFamily = "PingFang SC",
  projectDir = null,
} = {}) {
  const hasSpans = Array.isArray(node.spans) && node.spans.length > 0;
  const text = hasSpans
    ? node.spans.map(s => String(s?.text ?? "")).join("")
    : String(node.text ?? node.value ?? node.placeholder ?? "");
  const maxSpanFontSize = hasSpans
    ? Math.max(...node.spans.map(s => Number(s?.fontSize || s?.size || node.fontSize || 14)))
    : Number(node.fontSize || node.size || 14);
  const fontSize = maxSpanFontSize;
  const fontWeight = Number(node.fontWeight || node.weight || 400);
  const fontStyle = node.italic ? "italic" : "normal";
  const letterSpacing = Number(node.letterSpacing || 0);
  const lineHeight = Number(node.lineHeight || Math.max(Math.round(fontSize * 1.4), fontSize + 4));
  const requestedFont = node.fontFamily || node.font || defaultFontFamily || "PingFang SC";
  const fontDesc = resolveFontDescriptor(requestedFont, { defaultFontFamily, projectDir });
  const metricsEntry = getFontMetricsEntry(fontDesc.metricsFont, fontWeight);

  const hasBox = Boolean(
    node.type === "button" ||
    node.type === "input" ||
    node.type === "badge"
  );
  const padX = hasBox ? 16 : 0;
  const padY = hasBox ? 8 : 0;

  const maxWConstraint = typeof node.maxW === "number" ? node.maxW : null;
  const explicitW = typeof node.w === "number" ? node.w : null;
  const effectiveOuterW = explicitW !== null
    ? (maxWConstraint !== null ? Math.min(explicitW, maxWConstraint) : explicitW)
    : availableW !== null && (node.w === "fill" || Boolean(node.wrap || node.type === "paragraph" || text.includes("\n")))
      ? (maxWConstraint !== null ? Math.min(availableW, maxWConstraint) : availableW)
      : maxWConstraint;

  const wrapEnabled = Boolean(node.wrap || node.type === "paragraph" || text.includes("\n") || maxWConstraint !== null);
  const targetContentW = effectiveOuterW !== null ? Math.max(12, effectiveOuterW - padX) : null;
  const spansSig = hasSpans ? JSON.stringify(node.spans) : "";

  const cacheKey = buildTypographyCacheKey({
    resolvedFont: fontDesc.resolvedFont,
    fontWeight,
    fontStyle,
    fontSize,
    letterSpacing,
    lineHeight,
    text,
    spansSig,
    targetContentW,
    wrapEnabled,
    hasBox,
    bounds: [node.h, node.maxH, node.maxLines, node.ellipsis, fontDesc.requestedFont, fontDesc.status],
  });

  if (typographyCache.has(cacheKey)) {
    cacheHits++;
    return typographyCache.get(cacheKey);
  }
  cacheMisses++;

  const opts = {
    fontFamily: fontDesc.resolvedFont,
    fontSize,
    fontWeight,
    letterSpacing,
    defaultFontFamily,
    projectDir,
    italic: node.italic === true,
  };

  let lines;
  let lineWidths;
  if (hasSpans && !text.includes("\n") && targetContentW === null) {
    lines = [text];
    const spanW = node.spans.reduce((acc, sp) => {
      return acc + measureLineWidthExact(String(sp?.text ?? ""), {
        fontFamily: sp?.fontFamily || fontDesc.resolvedFont,
        fontSize: Number(sp?.fontSize || sp?.size || node.fontSize || 14),
        fontWeight: Number(sp?.fontWeight || sp?.weight || fontWeight),
        letterSpacing: Number(sp?.letterSpacing ?? letterSpacing),
        defaultFontFamily,
        projectDir,
      });
    }, 0);
    lineWidths = [Number(spanW.toFixed(2))];
  } else {
    const rawSingleLineW = measureLineWidthExact(text.replace(/\n/g, " "), opts);
    if (!text) {
      lines = [];
    } else if (targetContentW !== null && (wrapEnabled || text.includes("\n")) && (rawSingleLineW > targetContentW + 0.5 || text.includes("\n"))) {
      lines = wrapTextLinesExact(text, targetContentW, opts);
    } else if (text.includes("\n")) {
      lines = text.split("\n");
    } else {
      lines = [text];
    }
    lineWidths = lines.map(l => measureLineWidthExact(l, opts));
  }

  const originalLineCount = lines.length;
  const maxLines = Number.isInteger(node.maxLines) && node.maxLines > 0 ? node.maxLines : null;
  if (maxLines && lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    if (node.ellipsis !== false) {
      let last = lines.at(-1);
      const limit = targetContentW ?? Infinity;
      while (last && measureLineWidthExact(`${last}…`, opts) > limit) last = [...last].slice(0, -1).join('');
      lines[lines.length - 1] = `${last}…`;
    }
    lineWidths = lines.map(line => measureLineWidthExact(line, opts));
  }
  const maxLineW = lineWidths.length ? Math.max(...lineWidths) : 0;
  const contentW = Math.ceil(maxLineW);
  const lineCount = lines.length;
  const contentH = lineCount === 0 ? 0 : lineCount * lineHeight;

  const measuredW = lineCount === 0 ? padX : contentW + padX;
  const measuredH = lineCount === 0
    ? (hasBox ? lineHeight + padY : 0)
    : contentH + padY;

  const shapedMetrics = shapeText(text || ' ', { family: fontDesc.resolvedFont, size: fontSize, weight: fontWeight, italic: node.italic === true, file: fontDesc.fontFile });
  const ascentPx = shapedMetrics?.ascent ?? fontSize * (metricsEntry.ascent || 0.88);
  const descentPx = shapedMetrics?.descent ?? fontSize * (metricsEntry.descent || 0.22);
  const halfLeading = (lineHeight - (ascentPx + descentPx)) / 2;
  const firstBaselineOffset = Math.round((padY / 2) + Math.max(fontSize * 0.78, ascentPx + halfLeading));
  const lastBaselineOffset = lineCount > 1
    ? firstBaselineOffset + (lineCount - 1) * lineHeight
    : firstBaselineOffset;

  const boundW = explicitW !== null ? explicitW : maxWConstraint;
  const boundH = typeof node.h === "number" ? node.h : (typeof node.maxH === "number" ? node.maxH : null);
  const horizontalOverflowPx = boundW !== null && contentW + padX > boundW + 1
    ? Math.round(contentW + padX - boundW)
    : 0;
  const verticalOverflowPx = boundH !== null && measuredH > boundH + 1
    ? Math.round(measuredH - boundH)
    : 0;

  const result = {
    cacheKey,
    lines,
    lineCount,
    originalLineCount,
    truncated: originalLineCount !== lineCount,
    displayText: lines.join('\n'),
    lineWidths,
    contentW,
    contentH,
    w: measuredW,
    h: measuredH,
    measuredW,
    measuredH,
    padX,
    padY,
    fontSize,
    fontWeight,
    fontStyle,
    letterSpacing,
    lineHeight,
    ascentPx: Number(ascentPx.toFixed(2)),
    descentPx: Number(descentPx.toFixed(2)),
    firstBaselineOffset,
    lastBaselineOffset,
    requestedFont: fontDesc.requestedFont,
    resolvedFont: fontDesc.resolvedFont,
    fontStackCss: fontDesc.fontStackCss,
    fontStatus: fontDesc.status,
    isFontFallback: fontDesc.isFallback,
    fontFallbackReason: fontDesc.reason,
    measurementMode: shapedMetrics ? 'coretext-shaped' : getShapingStatus().provider,
    horizontalOverflowPx,
    verticalOverflowPx,
    clipped: horizontalOverflowPx > 0 || verticalOverflowPx > 0,
  };

  typographyCache.set(cacheKey, result);
  return result;
}

export const TYPOGRAPHY_FIXTURES_32 = [
  // 1-6: Chinese body text across PingFang SC & Songti SC
  { id: "fx01_zh_body_pf", category: "zh-body", text: "清晨的闽江口湿地薄雾微凉，黑脸琵鹭在浅滩缓步觅食。", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400 },
  { id: "fx02_zh_body_song", category: "zh-body", text: "清晨的闽江口湿地薄雾微凉，黑脸琵鹭在浅滩缓步觅食。", fontFamily: "Songti SC", fontSize: 14, fontWeight: 400 },
  { id: "fx03_zh_body_wrap_pf", category: "zh-body", text: "涨潮前两小时是观测鸻鹬类水鸟的最佳窗口，建议携带双筒望远镜并保持安静。", fontFamily: "PingFang SC", fontSize: 13, fontWeight: 400, w: 220, wrap: true },
  { id: "fx04_zh_body_wrap_song", category: "zh-body", text: "涨潮前两小时是观测鸻鹬类水鸟的最佳窗口，建议携带双筒望远镜并保持安静。", fontFamily: "Songti SC", fontSize: 13, fontWeight: 400, w: 220, wrap: true },
  { id: "fx05_zh_body_compact", category: "zh-body", text: "今日新增观测记录 12 条，含国家一级保护动物黑脸琵鹭 3 只。", fontFamily: "PingFang SC", fontSize: 12, fontWeight: 400, w: 180, wrap: true },
  { id: "fx06_zh_body_spaced", category: "zh-body", text: "山林溪谷 · 留鸟与旅鸟栖息生境全记录", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400, letterSpacing: 1 },

  // 7-12: Chinese headings across PingFang SC, Songti SC, Heiti SC
  { id: "fx07_zh_title_pf", category: "zh-heading", text: "去自然里，遇见飞羽 · 2026 迁徙季", fontFamily: "PingFang SC", fontSize: 22, fontWeight: 600 },
  { id: "fx08_zh_title_song", category: "zh-heading", text: "去自然里，遇见飞羽 · 2026 迁徙季", fontFamily: "Songti SC", fontSize: 22, fontWeight: 600 },
  { id: "fx09_zh_title_heiti", category: "zh-heading", text: "闽江口湿地公园 · 观鸟图鉴", fontFamily: "Heiti SC", fontSize: 20, fontWeight: 600 },
  { id: "fx10_zh_title_multiline_pf", category: "zh-heading", text: "秋水共长天：东亚-澳大利西亚候鸟迁徙廊道年度观察报告", fontFamily: "PingFang SC", fontSize: 18, fontWeight: 600, w: 260, wrap: true },
  { id: "fx11_zh_title_multiline_song", category: "zh-heading", text: "秋水共长天：东亚-澳大利西亚候鸟迁徙廊道年度观察报告", fontFamily: "Songti SC", fontSize: 18, fontWeight: 600, w: 260, wrap: true },
  { id: "fx12_zh_subtitle_spaced", category: "zh-heading", text: "QIYU FIELD NOTEBOOK · 自然观察手记", fontFamily: "PingFang SC", fontSize: 12, fontWeight: 600, letterSpacing: 2 },

  // 13-18: Latin letters & digits across Helvetica Neue, PingFang SC, Songti SC, Georgia, Menlo
  { id: "fx13_latin_hn", category: "latin-digits", text: "Birdwatching Field Journal 2026 - 48 Species", fontFamily: "Helvetica Neue", fontSize: 16, fontWeight: 400 },
  { id: "fx14_latin_pf", category: "latin-digits", text: "Birdwatching Field Journal 2026 - 48 Species", fontFamily: "PingFang SC", fontSize: 16, fontWeight: 400 },
  { id: "fx15_latin_song", category: "latin-digits", text: "Birdwatching Field Journal 2026 - 48 Species", fontFamily: "Songti SC", fontSize: 16, fontWeight: 400 },
  { id: "fx16_latin_georgia", category: "latin-digits", text: "Platalea minor & Alcedo atthis (Linnaeus, 1758)", fontFamily: "Georgia", fontSize: 15, fontWeight: 400 },
  { id: "fx17_digits_menlo", category: "latin-digits", text: "ID-2026-0928 #A042 99.8% [N26°04' E119°38']", fontFamily: "Menlo", fontSize: 13, fontWeight: 400 },
  { id: "fx18_latin_wrap_hn", category: "latin-digits", text: "Morning tide observation at Minjiang Estuary Wetland Reserve with 128 recorded waterbirds.", fontFamily: "Helvetica Neue", fontSize: 14, fontWeight: 400, w: 240, wrap: true },

  // 19-22: Punctuation-heavy strings (CJK & Latin punctuation)
  { id: "fx19_punct_cjk_pf", category: "punctuation", text: "《观鸟手记》：“普通翠鸟（Alcedo atthis）——体长 16cm；羽色翠蓝！”", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400 },
  { id: "fx20_punct_cjk_song", category: "punctuation", text: "《观鸟手记》：“普通翠鸟（Alcedo atthis）——体长 16cm；羽色翠蓝！”", fontFamily: "Songti SC", fontSize: 14, fontWeight: 400 },
  { id: "fx21_punct_kinsoku", category: "punctuation", text: "观测点位：鳝鱼滩、蝙蝠洲、道庆洲，退潮后浅滩视野极佳。", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400, w: 196, wrap: true },
  { id: "fx22_punct_symbols", category: "punctuation", text: "预算 ¥1,280.00 / €160 · 评分 ★4.9 → 已核验 ✓", fontFamily: "PingFang SC", fontSize: 13, fontWeight: 500 },

  // 23-25: Emoji & multi-codepoint grapheme clusters
  { id: "fx23_emoji_birds", category: "emoji", text: "🦜 翠鸟观测点 · 🌿 湿地保护区 ✨", fontFamily: "PingFang SC", fontSize: 15, fontWeight: 500 },
  { id: "fx24_emoji_status", category: "emoji", text: "📍 福州闽江口 · 🌤️ 21°C 微风 · 📷 4K 记录", fontFamily: "PingFang SC", fontSize: 13, fontWeight: 400 },
  { id: "fx25_emoji_wrap", category: "emoji", text: "🦉 夜行猛禽调查 · 🦢 越冬水鸟同步统计 · 🦩 珍稀旅鸟追踪", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400, w: 220, wrap: true },

  // 26-28: Long unbreakable words & extreme numbers
  { id: "fx26_longword_hn", category: "long-word", text: "Taxonomy: Charadriiformes_Scolopacidae_Eurynorhynchus_pygmeus_2026", fontFamily: "Helvetica Neue", fontSize: 14, fontWeight: 400, w: 180, wrap: true },
  { id: "fx27_longword_url", category: "long-word", text: "https://wetland-observatory.example.org/datasets/2026/autumn-migration-telemetry-archive", fontFamily: "Helvetica Neue", fontSize: 12, fontWeight: 400, w: 200, wrap: true },
  { id: "fx28_long_digits", category: "long-word", text: "SN-99887766554433221100-BATCH-20261026-VERIFIED", fontFamily: "Menlo", fontSize: 12, fontWeight: 400, w: 190, wrap: true },

  // 29-30: Explicit newlines (\n)
  { id: "fx29_explicit_newlines_zh", category: "newline", text: "第一行：闽江口湿地水鸟调查\n第二行：记录人林泽 · 06:40\n第三行：潮汐退潮期可见度佳", fontFamily: "PingFang SC", fontSize: 13, fontWeight: 400, w: 240, wrap: true },
  { id: "fx30_explicit_newlines_song", category: "newline", text: "春迁：3月—5月\n秋迁：9月—11月\n越冬：12月—次年2月", fontFamily: "Songti SC", fontSize: 14, fontWeight: 400, w: 200, wrap: true },

  // 31-32: Empty strings ""
  { id: "fx31_empty_label", category: "empty", text: "", fontFamily: "PingFang SC", fontSize: 14, fontWeight: 400 },
  { id: "fx32_empty_button", category: "empty", type: "button", text: "", fontFamily: "Helvetica Neue", fontSize: 14, fontWeight: 600, fill: "#205B45" },
];

