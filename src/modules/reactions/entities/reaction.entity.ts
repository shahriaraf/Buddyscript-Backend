import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ReactionTarget } from '../../../shared/enums';

@Entity('reactions')
@Unique('idx_reactions_unique', ['userId', 'targetType', 'targetId'])
@Index('idx_reactions_target', ['targetType', 'targetId'])
@Index('idx_reactions_user', ['userId', 'targetType'])
export class Reaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, (user) => user.reactions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'target_type', type: 'enum', enum: ReactionTarget })
  targetType: ReactionTarget;

  @Column({ name: 'target_id' })
  targetId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
