import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// roomId -> {admin, players, scores, currentQ, questions, answered}
let games = {};

io.on("connection", (socket) => {
  console.log("✅ User Connected:", socket.id);

  // Player joins a game
  socket.on("join_game", ({ roomId, playerName, isAdmin }) => {
    socket.join(roomId);

    if (!games[roomId]) {
      games[roomId] = {
        admin: null,
        players: {},
        scores: {},
        currentQ: 0,
        questions: [],
        answered: {}, // track answers per question
      };
    }

    const game = games[roomId];

    // Prevent duplicate joins
    if (game.players[socket.id]) return;

    // Assign admin if none exists
    if (isAdmin && !game.admin) {
      game.admin = socket.id;
      console.log(`⭐ Admin for room ${roomId} is ${socket.id}`);
    }

    game.players[socket.id] = playerName;
    game.scores[socket.id] = 0;

    // Send updated state to all players in room
    io.to(roomId).emit("game_state", {
      players: game.players,
      scores: game.scores,
      currentQ: game.currentQ,
    });
  });

  // Admin starts the quiz
  socket.on("start_quiz", ({ roomId, questions }) => {
    const game = games[roomId];
    if (!game) return;

    if (socket.id !== game.admin) return; // Only admin can start

    game.questions = questions;
    game.currentQ = 0;
    game.answered = {};

    io.to(roomId).emit("show_question", {
      question: questions[0],
      index: 0,
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

      if (game.players[socket.id]) {
        delete game.players[socket.id];
        delete game.scores[socket.id];

        io.to(roomId).emit("player_list", Object.values(game.players));

        // If admin left
        if (socket.id === game.admin) {
          const playerIds = Object.keys(game.players);
          if (playerIds.length > 0) {
            game.admin = playerIds[0]; // promote first player
            io.to(roomId).emit("new_admin", game.admin);
          } else {
            delete games[roomId]; // cleanup empty room
            console.log(`🗑️ Room ${roomId} deleted`);
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
});
