import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// --- Database Setup ---
const DB_URI = "mongodb+srv://sdtmanishbailwal_db_user:TErwqJTLIIDZsWpF@quizapp.vajuu70.mongodb.net/?retryWrites=true&w=majority&appName=QuizApp";

const QuestionSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    correctAnswer: { type: Number, required: true },
    mediaUrl: { type: String, required: false },
  },
  { timestamps: true }
);

const Question =
  mongoose.models.Question || mongoose.model("Question", QuestionSchema);

const dbConnect = async () => {
  if (mongoose.connection.readyState >= 1) return;
  try {
    await mongoose.connect(DB_URI);
    console.log("✅ MongoDB connected successfully from WebSocket server.");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
};
dbConnect();

// --- Helper Function ---
// Fisher-Yates shuffle algorithm
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// --- In-memory game storage ---
let games = {}; // roomId -> { admin, players, scores, playerQuestions, playerCurrentQIndex, answered }

// --- Socket.IO Events ---
io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  // Player/Admin joins a game
  socket.on("join_game", async ({ roomId, playerName, isAdmin }) => {
    // Create new room if admin
    if (!games[roomId]) {
      if (!isAdmin) {
        socket.emit("room_not_found");
        return;
      }

      games[roomId] = {
        admin: socket.id,
        adminName: playerName,
        players: {},
        scores: {},
        playerQuestions: {},
        playerCurrentQIndex: {},
        answered: {},
      };
      console.log(`⭐ Room ${roomId} created by admin ${playerName}`);
    }

    const game = games[roomId];

    // Prevent multiple admins
    if (isAdmin && socket.id !== game.admin) {
      socket.emit("admin_exists");
      return;
    }

    socket.join(roomId);

    // Only add to players if NOT admin
    if (!isAdmin) {
      game.players[socket.id] = playerName || "Anonymous";
      game.scores[socket.id] = 0;
      const allQuestions = await Question.find({});
      game.playerQuestions[socket.id] = shuffleArray(allQuestions);
      game.playerCurrentQIndex[socket.id] = 0;
    }

    // Send updated game state to all
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Admin starts the quiz
  socket.on("start_quiz", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.answered = {};

    for (const playerId in game.players) {
      const playerQuestions = game.playerQuestions[playerId];
      const qIndex = game.playerCurrentQIndex[playerId];
      if (playerQuestions.length > 0 && qIndex < playerQuestions.length) {
        const question = playerQuestions[qIndex];
        io.to(playerId).emit("show_question", { question, index: qIndex });
      }
    }

    io.to(roomId).emit("quiz_started");
  });

  // Admin moves to next question
  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game || socket.id !== game.admin) return;

    game.answered = {};

    let anyPlayerHasQuestionsLeft = false;
    for (const playerId in game.players) {
      game.playerCurrentQIndex[playerId]++;
      
      const nextQIndex = game.playerCurrentQIndex[playerId];
      const playerQuestions = game.playerQuestions[playerId];
      
      if (nextQIndex < playerQuestions.length) {
        const nextQuestion = playerQuestions[nextQIndex];
        io.to(playerId).emit("show_question", { question: nextQuestion, index: nextQIndex });
        anyPlayerHasQuestionsLeft = true;
      } else {
        io.to(playerId).emit("player_quiz_ended");
      }
    }

    if (!anyPlayerHasQuestionsLeft) {
      io.to(roomId).emit("quiz_ended", game.scores);
    }

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Player submits an answer
  socket.on("submit_answer", ({ roomId, questionId, answer }) => {
    const game = games[roomId];
    if (!game || !game.players[socket.id]) return;

    // Prevent multiple submissions
    if (game.answered[socket.id]) return;

    const currentQuestion = game.playerQuestions[socket.id].find(q => q._id.toString() === questionId);
    if (!currentQuestion) return;

    game.answered[socket.id] = true;

    if (answer === currentQuestion.correctAnswer) {
      game.scores[socket.id] += 10;
    }

    io.to(roomId).emit("score_update", game.scores);
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("❌ User Disconnected:", socket.id);

    for (const roomId in games) {
      const game = games[roomId];
      if (!game) continue;

      // Admin disconnects
      if (socket.id === game.admin) {
        const playerIds = Object.keys(game.players);
        if (playerIds.length > 0) {
          // Promote first player as new admin
          game.admin = playerIds[0];
          game.adminName = game.players[game.admin];
          delete game.players[game.admin];
          delete game.scores[game.admin];
          delete game.playerQuestions[game.admin];
          delete game.playerCurrentQIndex[game.admin];
        } else {
          delete games[roomId];
          console.log(`🗑️ Room ${roomId} deleted`);
          continue;
        }
      } else if (game.players[socket.id]) {
        // Player disconnects
        delete game.players[socket.id];
        delete game.scores[socket.id];
        delete game.playerQuestions[socket.id];
        delete game.playerCurrentQIndex[socket.id];
      }

      io.to(roomId).emit("game_state", {
        players: game.players,
        scores: game.scores,
        adminId: game.admin,
        adminName: game.adminName,
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});