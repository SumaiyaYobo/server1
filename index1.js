const express = require("express");
const speech = require("@google-cloud/speech");
const OpenAI = require("openai");
const dotenv = require("dotenv");

dotenv.config();

const logger = require("morgan");

const bodyParser = require("body-parser");

const cors = require("cors");

const http = require("http");
const { Server } = require("socket.io");

const app = express();

let globalLanguageCode = "en-US";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const languageMappings = {
  portuguese: "pt-BR",
  english: "en-US",
  hindi: "hi-IN",
  spanish: "es-ES",
  french: "fr-FR",
  german: "de-DE",
  chinese: "zh-CN",
  japanese: "ja-JP",
  korean: "ko-KR",
};

app.use(cors());
app.use(logger("dev"));

app.use(bodyParser.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

process.env.GOOGLE_APPLICATION_CREDENTIALS = "./speech-to-text-key.json";
//process.env.GOOGLE_APPLICATION_CREDENTIALS

const speechClient = new speech.SpeechClient();

io.on("connection", (socket) => {
  let recognizeStream = null;
  console.log("** a user connected - " + socket.id + " **\n");

  socket.on("disconnect", () => {
    console.log("** user disconnected ** \n");
  });

  socket.on("send_message", (message) => {
    console.log("message: " + message);
    setTimeout(() => {
      io.emit("receive_message", "got this message" + message);
    }, 1000);
  });

  socket.on("startGoogleCloudStream", function (data) {
    startRecognitionStream(this, data);
  });

  socket.on("endGoogleCloudStream", function () {
    console.log("** ending google cloud stream **\n");
    stopRecognitionStream();
  });

  socket.on("send_audio_data", async (audioData) => {
    io.emit("receive_message", "Got audio data");
    if (recognizeStream !== null) {
      try {
        recognizeStream.write(audioData.audio);
      } catch (err) {
        console.log("Error calling google api " + err);
      }
    } else {
      console.log("RecognizeStream is null");
    }
  });

  function startRecognitionStream(client) {
    console.log("* StartRecognitionStream\n");
    try {
      recognizeStream = speechClient
        .streamingRecognize(request)
        .on("error", console.error)
        .on("data", (data) => {
          const result = data.results[0];
          const isFinal = result.isFinal;

          const transcription = data.results
            .map((result) => result.alternatives[0].transcript)
            .join("\n");

          console.log(`Transcription: `, transcription);

          client.emit("receive_audio_text", {
            text: transcription,
            isFinal: isFinal,
          });

          // if end of utterance, let's restart stream
          // this is a small hack to keep restarting the stream on the server and keep the connection with Google api
          // Google api disconects the stream every five minutes
          if (data.results[0] && data.results[0].isFinal) {
            stopRecognitionStream();
            startRecognitionStream(client);
            console.log("restarted stream serverside");
          }
        });
    } catch (err) {
      console.error("Error streaming google api " + err);
    }
  }

  function stopRecognitionStream() {
    if (recognizeStream) {
      console.log("* StopRecognitionStream \n");
      recognizeStream.end();
    }
    recognizeStream = null;
  }
});

const encoding = "LINEAR16";
const sampleRateHertz = 16000;

const request = {
  config: {
    encoding: encoding,
    sampleRateHertz: sampleRateHertz,
    languageCode: globalLanguageCode,

    enableWordTimeOffsets: true,
    enableAutomaticPunctuation: true,
    enableWordConfidence: true,
    enableSpeakerDiarization: true,

    model: "command_and_search",

    useEnhanced: true,
  },
  interimResults: true,
};

function updateRequestConfig() {
  request.config.languageCode = globalLanguageCode;
}

function updateGlobalLanguageCode(newLanguageCode) {
  globalLanguageCode = newLanguageCode;
  console.log(`Global language code updated to: ${globalLanguageCode}`);
  updateRequestConfig();
}

console.log("Initial globalLanguageCode:", globalLanguageCode);
console.log(
  "Initial request.config.languageCode:",
  request.config.languageCode
);

async function change_language(query) {
  const prompt = `
    You are a language detection assistant. Your job is to determine the target language based on a user query.
    The query might include phrases like "Change the language to Portuguese" or "Switch back to Portuguese".
    Your output should only be the language name in English, such as "Portuguese" or "Hindi".
    Do not include any additional explanation or text in your response. Just return the language name in English.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: query },
      ],
      max_tokens: 100,
      temperature: 0.0,
    });

    const detectedLanguage = response.choices[0]?.message?.content
      ?.trim()
      .toLowerCase();

    if (!detectedLanguage) {
      throw new Error("Failed to detect a valid language.");
    }

    const languageCode = languageMappings[detectedLanguage];

    if (!languageCode) {
      throw new Error(
        `Could not map the detected language "${detectedLanguage}" to a language code.`
      );
    }

    updateGlobalLanguageCode(languageCode);
    return { languageCode };
  } catch (error) {
    return { error: error.message };
  }
}

async function answer_in_language(query) {
  const prompt = `
    Answer the following question in ${
      globalLanguageCode.split("-")[0]
    } in 1 or 2 lines only:
    Question: "${query}"
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant who always answers in the specified language.`,
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    const answer = response.choices[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error("Failed to generate an answer.");
    }

    return { answer };
  } catch (error) {
    return { error: error.message };
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "change_language",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Trigger this function when the user explicitly requests a change in the language setting. The query should contain the target language (e.g., 'Hindi', 'Spanish', 'French'). This function is ONLY used for setting or changing the language the conversation should continue in, not for handling queries in that language.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_in_language",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          languageCode: {
            type: "string",
            description:
              "The language code-country code in which the answer should be given (e.g., 'en-US' for English (US), 'hi-IN' for Hindi (India), 'es-ES' for Spanish (Spain)). This is determined based on the user's question language.",
          },
          query: {
            type: "string",
            description:
              "The user's query or question that needs to be answered. This function should be triggered when the user asks a question or makes a request in any language. The query can be in any language, such as Hindi, Spanish, French, etc. The primary purpose of this function is to handle and respond to questions in the detected language.",
          },
        },
        required: ["languageCode", "query"],
        additionalProperties: false,
      },
    },
  },
];

app.post("/api/process", async (req, res) => {
  const { text } = req.body;
  if (!text) {
    throw new Error("No text provided in the request body");
  }
  console.log(text);
  let ans;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: text }],
      tool_choice: "required",
      tools: tools,
    });

    const function_name =
      response.choices[0]?.message?.tool_calls?.[0]?.function?.name;
    const rawFunctionArguments =
      response.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
    let function_arguments;

    if (typeof rawFunctionArguments === "string") {
      function_arguments = JSON.parse(rawFunctionArguments);
    } else {
      function_arguments = rawFunctionArguments;
    }

    if (function_name === "change_language" && function_arguments?.query) {
      const response2 = await change_language(function_arguments.query);
      ans = response2.languageCode || response2.error;
    } else if (
      function_name === "answer_in_language" &&
      function_arguments?.query
    ) {
      const response1 = await answer_in_language(function_arguments.query);
      ans = response1.answer || response1.error;
    } else {
      throw new Error("Unhandled function or missing arguments.");
    }

    res.json({ result: ans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

server.listen(8081, () => {
  console.log("WebSocket server listening on port 8081.");
});


