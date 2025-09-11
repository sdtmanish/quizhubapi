import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from 'mongoose';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// --- Self-contained Database Connection and Model Definition ---

// Define the database URL with the hardcoded URL as requested.
const DB_URI = "mongodb+srv://sdtmanishbailwal_db_user:TErwqJTLIIDZsWpF@quizapp.vajuu70.mongodb.net/?retryWrites=true&w=majority&appName=QuizApp";

// Define the Question model directly in this file
const QuestionSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
  },
  question: {
    type: String,
    required: true,
  },
  options: {
    type: [String],
    required: true,
  },
  correctAnswer: {
    type: Number,
    required: true,
  },
  mediaUrl: {
    type: String,
    required: false,
  },
}, { timestamps: true });

const Question = mongoose.models.Question || mongoose.model('Question', QuestionSchema);

// Simple function to connect to the database
const dbConnect = async () => {
  if (mongoose.connection.readyState >= 1) {
    return;
  }
  try {
    await mongoose.connect(DB_URI);
    console.log("✅ MongoDB connected successfully from WebSocket server.");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
};

// --- End of Database Setup ---

// Connect to the database immediately on server startup.
dbConnect();

// roomId -> {admin, players, scores, currentQ, questions, answered, adminName}
let games = {};

io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  // Player joins a game
  socket.on("join_game", ({ roomId, playerName }) => {
    socket.join(roomId);

    if (!games[roomId]) {
      games[roomId] = {
        admin: null,
        adminName: null,
        players: {},
        scores: {},
        currentQ: 0,
        questions: [],
        answered: {}, // track answers per question
      };
    }

    const game = games[roomId];

    // Check if the user is reconnecting.
    if (game.players[socket.id] || game.admin === socket.id) {
      socket.emit("game_state", {
        players: game.players,
        scores: game.scores,
        currentQ: game.currentQ,
        adminId: game.admin,
        adminName: game.adminName,
      });
      return;
    }

    // If no admin exists, make the first player to join the admin.
    if (!game.admin) {
      game.admin = socket.id;
      game.adminName = playerName;
      console.log(`⭐ Admin for room ${roomId} is ${socket.id}`);
    } else {
      // Add non-admin players to the players object.
      game.players[socket.id] = playerName;
      game.scores[socket.id] = 0;
    }

    // Send updated state to all players in room
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Admin starts the quiz
  socket.on("start_quiz", async ({ roomId }) => {
    const game = games[roomId];
    if (!game) return;

    if (socket.id !== game.admin) return; // Only admin can start

    // Fetch all questions from the already connected database
    const questions = await Question.find({});
    
    // Check if any questions were found
    if (questions.length === 0) {
      socket.emit("no_questions_found");
      return;
    }

    // Store the fetched questions in the game state
    game.questions = questions;
    game.currentQ = 0;
    game.answered = {};

    io.to(roomId).emit("show_question", {
      question: questions[0],
      index: 0,
    });

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Admin presses "Next"
  socket.on("next_question", ({ roomId }) => {
    const game = games[roomId];
    if (!game) return;

    if (socket.id !== game.admin) return; // Only admin can move next

    game.currentQ++;
    game.answered = {}; // reset answers for new question

    if (game.currentQ < game.questions.length) {
      io.to(roomId).emit("show_question", {
        question: game.questions[game.currentQ],
        index: game.currentQ,
      });
    } else {
      io.to(roomId).emit("quiz_ended", game.scores);
    }

    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
      adminId: game.admin,
      adminName: game.adminName,
    });
  });

  // Player submits an answer
  socket.on("submit_answer", ({ roomId, answer }) => {
    const game = games[roomId];
    if (!game) return;

    const qIndex = game.currentQ;
    const currentQuestion = game.questions[qIndex];
    if (!currentQuestion) return;

    // Prevent multiple answers from same player
    if (game.answered[socket.id]) return;
    game.answered[socket.id] = true;

    // Check correctness
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

      // If the disconnecting user is the admin
      if (socket.id === game.admin) {
        const playerIds = Object.keys(game.players);
        if (playerIds.length > 0) {
          // Promote the first player in the list to admin
          game.admin = playerIds[0];
          game.adminName = game.players[game.admin];
          
          // Remove the promoted player from the players list
          delete game.players[game.admin];
          delete game.scores[game.admin];
        } else {
          delete games[roomId]; // cleanup empty room
          console.log(`🗑️ Room ${roomId} deleted`);
          return;
        }
      } else if (game.players[socket.id]) {
        // If a regular player left, just remove them
        delete game.players[socket.id];
        delete game.scores[socket.id];
      }
      
      // Send the full game_state to update the UI
      io.to(roomId).emit("game_state", {
        players: game.players,
        scores: game.scores,
        currentQ: game.currentQ,
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
