import { Box, Text } from "ink";
import type React from "react";
import { colors } from "./colors.js";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  id: string;
  priority?: "high" | "medium" | "low";
}

interface TodoRendererProps {
  todos: TodoItem[];
}

export const TodoRenderer: React.FC<TodoRendererProps> = ({ todos }) => {
  return (
    <Box flexDirection="column">
      {todos.map((todo, index) => {
        const checkbox = todo.status === "completed" ? "☒" : "☐";

        // Format based on status
        let textElement: React.ReactNode;
        if (todo.status === "completed") {
          // Green with strikethrough
          textElement = (
            <Text color={colors.todo.completed} strikethrough>
              {checkbox} {todo.content}
            </Text>
          );
        } else if (todo.status === "in_progress") {
          // Blue bold (like code formatting)
          textElement = (
            <Text color={colors.todo.inProgress} bold>
              {checkbox} {todo.content}
            </Text>
          );
        } else {
          // Plain text for pending
          textElement = (
            <Text>
              {checkbox} {todo.content}
            </Text>
          );
        }

        // First item gets the prefix, others get indentation
        const prefix = index === 0 ? "  ⎿  " : "     ";

        return (
          <Box key={todo.id || index}>
            <Text>{prefix}</Text>
            {textElement}
          </Box>
        );
      })}
    </Box>
  );
};
